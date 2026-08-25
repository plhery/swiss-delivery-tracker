import ActivityKit
import Foundation
import UIKit
import UserNotifications
import WidgetKit

@MainActor
final class ParcelStore: ObservableObject {
    @Published private(set) var parcels: [Parcel] = [] {
        didSet { publishDeliverySurfaces() }
    }
    @Published private(set) var loading = false
    @Published private(set) var refreshing = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var authenticationRequired = false
    @Published private(set) var usingCachedData = false
    @Published private(set) var notificationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var notificationsEnabledOnDevice = false
    @Published private(set) var notificationPreferences: NotificationPreferences?
    @Published private(set) var notificationError: String?
    @Published private(set) var deliveryWidgetEnabled = true
    @Published private(set) var deliveryLiveActivitiesEnabled = true
    @Published private(set) var deliveryLiveActivityError: String?
    @Published var undoParcel: Parcel?

    let configuration: AppConfiguration
    private unowned let session: SessionStore
    private let localizer: Localizer
    private let api: DeliveryAPIClient
    private let demo: DemoRepository
    private let deliveryWidgetStore: DeliveryWidgetSharedStore?
    private let cache = ParcelCache()
    private var pollingTask: Task<Void, Never>?
    private var jobMonitoringTask: Task<Void, Never>?
    private var deliveryActivityTask: Task<Void, Never>?
    private var deliveryPushToStartTask: Task<Void, Never>?
    private var deliveryActivityUpdatesTask: Task<Void, Never>?
    private var deliveryActivityPushTokenTasks: [String: Task<Void, Never>] = [:]
    private var deliveryActivityStateTasks: [String: Task<Void, Never>] = [:]
    private var pendingJobIDs = Set<UUID>()
    private var isActive = true
    private var lastStartedAsDemo: Bool?
    private var notificationEnableInProgress = false
    private var nativePushGeneration = 0
    private var deliveryLiveActivityGeneration = 0
    private var deliveryLiveActivitySystemDisabled = false
    private var deliveryLiveActivityRegistrationRemovalPending = false
    private let installationID: UUID
    private let notificationOptOutKey = "sdt.notificationsDeviceOptOut"
    private let nativePushRegisteredKey = "sdt.notificationsNativePushRegistered.v1"
    private let demoNotificationsKey = "sdt.demoNotificationsEnabled"
    private static let installationIDKey = "sdt.installationID.v1"

    init(configuration: AppConfiguration = .current, session: SessionStore, localizer: Localizer) {
        self.configuration = configuration
        self.session = session
        self.localizer = localizer
        installationID = Self.installationIdentifier()
        deliveryWidgetStore = DeliveryWidgetSharedStore(
            appGroupIdentifier: configuration.appGroupIdentifier,
            fallbackToStandard: true
        )
        api = DeliveryAPIClient(configuration: configuration, session: session)
        demo = DemoRepository()
        deliveryWidgetEnabled = deliveryWidgetStore?.isEnabled ?? true
        deliveryLiveActivitiesEnabled = deliveryWidgetStore?.liveActivitiesEnabled ?? true
        deliveryLiveActivityRegistrationRemovalPending = !deliveryLiveActivitiesEnabled
        deliveryWidgetStore?.setLiveActivitiesEnabled(deliveryLiveActivitiesEnabled)
    }

    var isDemo: Bool { session.isDemo }
    var activeCount: Int { parcels.filter(\.isActive).count }
    var isSynchronizing: Bool {
        parcels.contains { $0.syncStatus == .pending || $0.syncStatus == .syncing }
    }

    func setDeliveryWidgetEnabled(_ enabled: Bool) {
        guard deliveryWidgetEnabled != enabled else { return }
        deliveryWidgetEnabled = enabled
        deliveryWidgetStore?.setEnabled(enabled)
        publishDeliveryWidget()
    }

    func setDeliveryLiveActivitiesEnabled(_ enabled: Bool) {
        guard deliveryLiveActivitiesEnabled != enabled else { return }
        deliveryLiveActivitiesEnabled = enabled
        deliveryWidgetStore?.setLiveActivitiesEnabled(enabled)
        deliveryLiveActivitySystemDisabled = false
        deliveryLiveActivityRegistrationRemovalPending = !enabled
        deliveryLiveActivityError = nil
        if enabled {
            startDeliveryLiveActivityObservers()
        } else {
            stopDeliveryLiveActivityObservers()
        }
        scheduleDeliveryLiveActivities()
    }

    func refreshDeliverySurfaces() {
        publishDeliverySurfaces()
        registerCurrentDeliveryPushToStartToken()
        registerCurrentDeliveryActivityUpdateTokens()
    }

    func clearDeliverySurfaces() {
        deliveryWidgetStore?.setLanguageCode(localizer.language.rawValue)
        deliveryWidgetStore?.clearSnapshot()
        WidgetCenter.shared.reloadTimelines(ofKind: DeliveryWidgetSharedStore.kind)
        scheduleDeliveryLiveActivities(forceEnd: true)
    }

    func start() async {
        pollingTask?.cancel()
        jobMonitoringTask?.cancel()
        jobMonitoringTask = nil
        pendingJobIDs.removeAll()
        if let lastStartedAsDemo, lastStartedAsDemo != isDemo {
            parcels = []
        }
        lastStartedAsDemo = isDemo
        errorMessage = nil
        authenticationRequired = false
        usingCachedData = false
        guard session.isAuthenticated else {
            parcels = []
            loading = false
            return
        }
        await load(showSpinner: true)
        await refreshNotificationState()
        startDeliveryLiveActivityObservers()
        if !isDemo {
            await loadNotificationPreferences()
            beginPolling()
        }
    }

    func setActive(_ active: Bool) {
        isActive = active
        if active && session.isAuthenticated {
            registerCurrentDeliveryPushToStartToken()
            registerCurrentDeliveryActivityUpdateTokens()
            Task { await load(showSpinner: false) }
        }
    }

    func load(showSpinner: Bool = false) async {
        if showSpinner && parcels.isEmpty { loading = true }
        do {
            let next = try await list()
            parcels = next
            errorMessage = nil
            authenticationRequired = false
            usingCachedData = false
            if !isDemo, let userID = session.user?.id {
                try? cache.save(next, userID: userID)
            }
        } catch {
            errorMessage = localizer.errorMessage(error)
            if let apiError = error as? DeliveryAPIError,
               case .authenticationExpired = apiError {
                authenticationRequired = true
            } else {
                authenticationRequired = false
            }
            if parcels.isEmpty,
               !isDemo,
               let userID = session.user?.id,
               let cached = cache.load(userID: userID) {
                parcels = cached
                usingCachedData = true
            }
        }
        loading = false
    }

    func add(
        trackingNumber: String,
        label: String,
        carrier: CarrierID,
        trackingURL: String?,
        dpdPostcode: String?
    ) async throws {
        let request = CreatePackageRequest(
            trackingNumber: CarrierCatalog.normalize(trackingNumber),
            label: label.trimmingCharacters(in: .whitespacesAndNewlines),
            carrier: carrier,
            trackingURL: trackingURL?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
            dpdPostcode: dpdPostcode?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        )
        let parcel: Parcel
        if isDemo {
            parcel = try demo.add(request)
        } else {
            let response = try await api.add(request)
            parcel = response.package
            monitorJobs(response.jobIDs)
        }
        upsert(parcel)
    }

    func rename(_ parcel: Parcel, label: String) async throws {
        let cleaned = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let updated = isDemo
            ? try demo.rename(id: parcel.id, label: cleaned)
            : try await api.rename(id: parcel.id, label: cleaned)
        upsert(updated)
    }

    func setMuted(_ parcel: Parcel, muted: Bool) async throws {
        let updated = isDemo
            ? try demo.setMuted(id: parcel.id, muted: muted)
            : try await api.setMuted(id: parcel.id, muted: muted)
        upsert(updated)
    }

    func archive(_ parcel: Parcel) async throws {
        if isDemo { try demo.archive(id: parcel.id) }
        else { try await api.archive(id: parcel.id) }
        var updated = parcel
        updated.archivedAt = DateParser.isoString(Date())
        upsert(updated)
        undoParcel = parcel
    }

    func restore(_ parcel: Parcel) async throws {
        let restored = isDemo
            ? try demo.restore(id: parcel.id)
            : try await api.restore(id: parcel.id)
        upsert(restored)
        if undoParcel?.id == parcel.id { undoParcel = nil }
    }

    func permanentlyDelete(_ parcel: Parcel) async throws {
        if isDemo { try demo.permanentlyDelete(id: parcel.id) }
        else { try await api.permanentlyDelete(id: parcel.id) }
        parcels.removeAll { $0.id == parcel.id }
        if undoParcel?.id == parcel.id { undoParcel = nil }
    }

    func refreshAll() async throws {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        if isDemo {
            parcels = demo.refreshAll()
        } else {
            try await api.refreshAll()
            await load(showSpinner: false)
        }
    }

    func refresh(_ parcel: Parcel) async throws {
        if isDemo {
            upsert(try demo.refresh(id: parcel.id))
        } else {
            try await api.refresh(id: parcel.id)
            await load(showSpinner: false)
        }
    }

    func exportAccount() async throws -> URL {
        let data: Data
        if isDemo {
            data = try JSONEncoder.deliveryTracker.encode(DemoExport(
                exportedAt: DateParser.isoString(Date()),
                mode: "demo",
                packages: parcels
            ))
        } else {
            data = try await api.exportAccount()
        }
        let day = ParcelOrganizer.dayKey(Date())
        let url = FileManager.default.temporaryDirectory
            .appending(path: "swiss-delivery-tracker-export-\(day).json")
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return url
    }

    func deleteAccount(confirmation: String) async throws {
        guard !isDemo else {
            demo.reset()
            parcels = []
            await endAllDeliveryLiveActivities()
            return
        }
        nativePushGeneration += 1
        deliveryLiveActivityGeneration += 1
        deliveryLiveActivityRegistrationRemovalPending = true
        stopDeliveryLiveActivityObservers()
        jobMonitoringTask?.cancel()
        pendingJobIDs.removeAll()
        try await api.deleteAccount(confirmation: confirmation)
        await endAllDeliveryLiveActivities()
        UIApplication.shared.unregisterForRemoteNotifications()
        AppDelegate.clearDeviceToken()
        UserDefaults.standard.set(true, forKey: notificationOptOutKey)
        UserDefaults.standard.set(false, forKey: nativePushRegisteredKey)
        notificationsEnabledOnDevice = false
        notificationPreferences = nil
        notificationError = nil
        if let userID = session.user?.id { cache.delete(userID: userID) }
        session.forceSignOut()
        parcels = []
    }

    func signOut() async throws {
        nativePushGeneration += 1
        deliveryLiveActivityGeneration += 1
        deliveryLiveActivityRegistrationRemovalPending = true
        jobMonitoringTask?.cancel()
        pendingJobIDs.removeAll()
        if let token = AppDelegate.currentDeviceToken, !isDemo {
            try? await api.unregisterNativePushToken(token)
        }
        if !isDemo { try? await api.unregisterLiveActivityDevice(installationID: installationID) }
        stopDeliveryLiveActivityObservers()
        await endAllDeliveryLiveActivities()
        UIApplication.shared.unregisterForRemoteNotifications()
        AppDelegate.clearDeviceToken()
        UserDefaults.standard.set(true, forKey: notificationOptOutKey)
        UserDefaults.standard.set(false, forKey: nativePushRegisteredKey)
        notificationsEnabledOnDevice = false
        notificationPreferences = nil
        notificationError = nil
        if let userID = session.user?.id { cache.delete(userID: userID) }
        try await session.signOut()
        pollingTask?.cancel()
        parcels = []
    }

    func refreshNotificationState() async {
        notificationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        let optedOut = UserDefaults.standard.bool(forKey: notificationOptOutKey)
        notificationsEnabledOnDevice = NotificationDevicePolicy.isEnabled(
            isDemo: isDemo,
            status: notificationStatus,
            optedOut: optedOut,
            nativePushRegistered: UserDefaults.standard.bool(forKey: nativePushRegisteredKey),
            demoNotificationsEnabled: UserDefaults.standard.bool(forKey: demoNotificationsKey)
        )
        if NotificationDevicePolicy.shouldRegisterForRemoteNotifications(
            status: notificationStatus,
            optedOut: optedOut
        ) {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func enableNotifications(language: AppLanguage) async throws -> Bool {
        notificationEnableInProgress = true
        defer { notificationEnableInProgress = false }
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        )
        await refreshNotificationState()
        guard granted else { throw DeliveryAPIError.notificationsDenied }
        UserDefaults.standard.set(false, forKey: notificationOptOutKey)
        UIApplication.shared.registerForRemoteNotifications()
        if isDemo {
            UserDefaults.standard.set(true, forKey: demoNotificationsKey)
            notificationsEnabledOnDevice = true
            return true
        }
        guard let token = await waitForAPNSToken() else {
            throw DeliveryAPIError.pushTokenUnavailable
        }
        let sent = try await api.registerNativePushToken(
            token,
            installationID: installationID,
            language: language,
            sendTest: true
        )
        UserDefaults.standard.set(true, forKey: nativePushRegisteredKey)
        notificationsEnabledOnDevice = true
        return sent
    }

    func disableNotifications() async throws {
        nativePushGeneration += 1
        let token = AppDelegate.currentDeviceToken
        if let token, !isDemo { try await api.unregisterNativePushToken(token) }
        UIApplication.shared.unregisterForRemoteNotifications()
        AppDelegate.clearDeviceToken()
        UserDefaults.standard.set(true, forKey: notificationOptOutKey)
        UserDefaults.standard.set(false, forKey: nativePushRegisteredKey)
        UserDefaults.standard.set(false, forKey: demoNotificationsKey)
        notificationsEnabledOnDevice = false
        await refreshNotificationState()
    }

    func deferNotificationOnboarding() {
        nativePushGeneration += 1
        let token = AppDelegate.currentDeviceToken
        if let token, !isDemo {
            Task { try? await api.unregisterNativePushToken(token) }
        }
        UIApplication.shared.unregisterForRemoteNotifications()
        AppDelegate.clearDeviceToken()
        UserDefaults.standard.set(true, forKey: notificationOptOutKey)
        UserDefaults.standard.set(false, forKey: nativePushRegisteredKey)
        UserDefaults.standard.set(false, forKey: demoNotificationsKey)
        notificationsEnabledOnDevice = false
        notificationError = nil
    }

    func loadNotificationPreferences() async {
        do {
            notificationPreferences = isDemo
                ? demo.notificationPreferences
                : try await api.notificationPreferences()
            notificationError = nil
        } catch {
            notificationError = localizer.errorMessage(error)
        }
    }

    func saveNotificationPreferences(_ value: NotificationPreferences) async throws {
        notificationPreferences = isDemo
            ? demo.saveNotificationPreferences(value)
            : try await api.saveNotificationPreferences(value)
        notificationError = nil
    }

    func forwardNativePushToken(_ token: String, language: AppLanguage) async {
        guard !isDemo,
              session.isAuthenticated,
              !notificationEnableInProgress,
              !UserDefaults.standard.bool(forKey: notificationOptOutKey) else { return }
        let generation = nativePushGeneration
        do {
            _ = try await api.registerNativePushToken(
                token,
                installationID: installationID,
                language: language,
                sendTest: false
            )
            if generation != nativePushGeneration
                || !session.isAuthenticated
                || UserDefaults.standard.bool(forKey: notificationOptOutKey) {
                try? await api.unregisterNativePushToken(token)
                return
            }
            UserDefaults.standard.set(true, forKey: nativePushRegisteredKey)
            notificationsEnabledOnDevice = session.isAuthenticated
            notificationError = nil
        } catch {
            notificationError = localizer.errorMessage(error)
        }
    }

    private func list() async throws -> [Parcel] {
        if isDemo { return demo.list() }
        return try await api.listPackages()
    }

    private func upsert(_ parcel: Parcel) {
        if let index = parcels.firstIndex(where: { $0.id == parcel.id }) { parcels[index] = parcel }
        else { parcels.append(parcel) }
    }

    private func publishDeliverySurfaces() {
        publishDeliveryWidget()
        scheduleDeliveryLiveActivities()
    }

    private func publishDeliveryWidget() {
        let snapshot: DeliveryWidgetSnapshot?
        if deliveryWidgetEnabled {
            let ordered = ParcelOrganizer.visible(
                parcels,
                query: "",
                status: .active,
                carrier: nil,
                sort: .priority
            )
            let candidates = ordered.map { parcel in
                DeliveryWidgetParcel(
                    id: parcel.id,
                    label: parcel.label.nonEmpty ?? localizer.text("common.parcel"),
                    carrier: CarrierCatalog.shared.info(for: parcel.carrier).displayName,
                    trackingNumber: CarrierCatalog.format(parcel.trackingNumber),
                    detail: parcel.expectedDelivery.map { localizer.expectedDelivery($0) }
                        ?? localizer.text(parcel.displayStatus.key),
                    isOutForDelivery: parcel.currentStage == .outForDelivery
                )
            }
            snapshot = DeliveryWidgetSnapshot(
                generatedAt: Date(),
                languageCode: localizer.language.rawValue,
                parcels: DeliveryWidgetSelection.displayParcels(from: candidates)
            )
        } else {
            snapshot = nil
        }

        deliveryWidgetStore?.setLanguageCode(localizer.language.rawValue)
        deliveryWidgetStore?.setEnabled(deliveryWidgetEnabled)
        if let snapshot {
            _ = deliveryWidgetStore?.save(snapshot)
        } else {
            deliveryWidgetStore?.clearSnapshot()
        }
        WidgetCenter.shared.reloadTimelines(ofKind: DeliveryWidgetSharedStore.kind)
    }

    private func scheduleDeliveryLiveActivities(forceEnd: Bool = false) {
        deliveryActivityTask?.cancel()
        deliveryActivityTask = Task { [weak self] in
            guard let self else { return }
            if forceEnd {
                await self.endAllDeliveryLiveActivities()
            } else {
                await self.updateDeliveryLiveActivities(parcels: self.parcels)
            }
        }
    }

    private func updateDeliveryLiveActivities(parcels: [Parcel]) async {
        let activities = Activity<DeliveryActivityAttributes>.activities
        guard deliveryLiveActivitiesEnabled else {
            await endAllDeliveryLiveActivities()
            await unregisterDeliveryLiveActivityDevice()
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            deliveryLiveActivitySystemDisabled = true
            deliveryLiveActivityError = localizer.text("liveActivity.systemDisabled")
            return
        }
        if deliveryLiveActivitySystemDisabled {
            deliveryLiveActivitySystemDisabled = false
            deliveryLiveActivityError = nil
        }

        let parcelsByID = Dictionary(uniqueKeysWithValues: parcels.map { ($0.id, $0) })
        var primaryActivityByParcel: [UUID: Activity<DeliveryActivityAttributes>] = [:]
        var duplicateActivityIDs = Set<String>()
        for activity in activities {
            let parcelID = activity.attributes.parcelID
            if primaryActivityByParcel[parcelID] == nil {
                primaryActivityByParcel[parcelID] = activity
            } else {
                duplicateActivityIDs.insert(activity.id)
            }
        }

        let orderedOutForDelivery = ParcelOrganizer.visible(
            parcels,
            query: "",
            status: .active,
            carrier: nil,
            sort: .priority
        ).filter { $0.currentStage == .outForDelivery }
        var desiredParcelIDs: [UUID] = []
        for activity in activities where !duplicateActivityIDs.contains(activity.id) {
            let parcelID = activity.attributes.parcelID
            guard parcelsByID[parcelID]?.currentStage == .outForDelivery else { continue }
            if !desiredParcelIDs.contains(parcelID) && desiredParcelIDs.count < 2 {
                desiredParcelIDs.append(parcelID)
            }
        }
        for parcel in orderedOutForDelivery
        where desiredParcelIDs.count < 2 && !desiredParcelIDs.contains(parcel.id) {
            desiredParcelIDs.append(parcel.id)
        }
        let desired = Set(desiredParcelIDs)

        for activity in activities {
            if duplicateActivityIDs.contains(activity.id) {
                await endDeliveryLiveActivity(activity)
                continue
            }
            guard let parcel = parcelsByID[activity.attributes.parcelID], !parcel.isArchived else {
                await endDeliveryLiveActivity(activity)
                continue
            }
            if parcel.currentStage == .outForDelivery && desired.contains(parcel.id) {
                let relevance = desiredParcelIDs.firstIndex(of: parcel.id) == 0 ? 1.0 : 0.8
                await activity.update(deliveryActivityContent(
                    for: parcel,
                    phase: .outForDelivery,
                    relevanceScore: relevance
                ))
                observeDeliveryLiveActivity(activity)
            } else if let phase = parcel.currentStage?.deliveryActivityPhase,
                      phase != .outForDelivery {
                let content = deliveryActivityContent(
                    for: parcel,
                    phase: phase,
                    staleDate: nil,
                    relevanceScore: 1
                )
                let grace: TimeInterval = phase == .failedAttempt || phase == .readyForPickup
                    ? 60 * 60
                    : 30 * 60
                await activity.end(
                    content,
                    dismissalPolicy: .after(Date().addingTimeInterval(grace))
                )
                await unregisterDeliveryLiveActivity(activityID: activity.id)
            } else {
                await endDeliveryLiveActivity(activity)
            }
        }

        let existingParcelIDs = Set(
            Activity<DeliveryActivityAttributes>.activities.map(\.attributes.parcelID)
        )
        for parcelID in desiredParcelIDs where !existingParcelIDs.contains(parcelID) {
            guard let parcel = parcelsByID[parcelID] else { continue }
            let relevance = desiredParcelIDs.firstIndex(of: parcelID) == 0 ? 1.0 : 0.8
            startDeliveryLiveActivity(for: parcel, relevanceScore: relevance)
        }
    }

    private func startDeliveryLiveActivity(for parcel: Parcel, relevanceScore: Double) {
        let attributes = DeliveryActivityAttributes(parcelID: parcel.id)
        let content = deliveryActivityContent(
            for: parcel,
            phase: .outForDelivery,
            relevanceScore: relevanceScore
        )
        let activity: Activity<DeliveryActivityAttributes>?
        do {
            activity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: .token
            )
        } catch {
            activity = try? Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil
            )
        }
        if let activity { observeDeliveryLiveActivity(activity) }
    }

    private func deliveryActivityContent(
        for parcel: Parcel,
        phase: DeliveryActivityPhase,
        staleDate: Date? = Date().addingTimeInterval(30 * 60),
        relevanceScore: Double = 0
    ) -> ActivityContent<DeliveryActivityAttributes.ContentState> {
        let status = localizer.text(parcel.displayStatus.key)
        let detail = phase == .outForDelivery
            ? parcel.expectedDelivery.map { localizer.expectedDelivery($0) } ?? status
            : status
        let activityParcel = DeliveryActivityParcel(
            id: parcel.id,
            label: parcel.label.nonEmpty ?? localizer.text("common.parcel"),
            carrier: CarrierCatalog.shared.info(for: parcel.carrier).displayName,
            status: status,
            detail: detail,
            phase: phase
        )
        return ActivityContent(
            state: DeliveryActivityAttributes.ContentState(
                parcel: activityParcel,
                languageCode: localizer.language.rawValue
            ),
            staleDate: staleDate,
            relevanceScore: relevanceScore
        )
    }

    private func endDeliveryLiveActivity(
        _ activity: Activity<DeliveryActivityAttributes>
    ) async {
        await activity.end(nil, dismissalPolicy: .immediate)
        await unregisterDeliveryLiveActivity(activityID: activity.id)
    }

    private func endAllDeliveryLiveActivities() async {
        for activity in Activity<DeliveryActivityAttributes>.activities {
            await endDeliveryLiveActivity(activity)
        }
    }

    private func startDeliveryLiveActivityObservers() {
        stopDeliveryLiveActivityObservers()
        guard deliveryLiveActivitiesEnabled, !isDemo, session.isAuthenticated else { return }
        deliveryLiveActivityRegistrationRemovalPending = false
        let generation = deliveryLiveActivityGeneration

        for activity in Activity<DeliveryActivityAttributes>.activities {
            observeDeliveryLiveActivity(activity)
        }
        deliveryPushToStartTask = Task { [weak self] in
            guard let self else { return }
            if let token = Activity<DeliveryActivityAttributes>.pushToStartToken {
                await self.registerDeliveryPushToStartToken(token, generation: generation)
            }
            for await token in Activity<DeliveryActivityAttributes>.pushToStartTokenUpdates {
                if Task.isCancelled { return }
                await self.registerDeliveryPushToStartToken(token, generation: generation)
            }
        }
        deliveryActivityUpdatesTask = Task { [weak self] in
            guard let self else { return }
            for await activity in Activity<DeliveryActivityAttributes>.activityUpdates {
                if Task.isCancelled { return }
                self.observeDeliveryLiveActivity(activity)
                await self.trimExcessDeliveryLiveActivities()
            }
        }
    }

    private func stopDeliveryLiveActivityObservers() {
        deliveryLiveActivityGeneration += 1
        deliveryPushToStartTask?.cancel()
        deliveryPushToStartTask = nil
        deliveryActivityUpdatesTask?.cancel()
        deliveryActivityUpdatesTask = nil
        deliveryActivityPushTokenTasks.values.forEach { $0.cancel() }
        deliveryActivityPushTokenTasks.removeAll()
        deliveryActivityStateTasks.values.forEach { $0.cancel() }
        deliveryActivityStateTasks.removeAll()
    }

    private func observeDeliveryLiveActivity(
        _ activity: Activity<DeliveryActivityAttributes>
    ) {
        guard deliveryLiveActivitiesEnabled,
              !deliveryLiveActivityRegistrationRemovalPending,
              !isDemo,
              session.isAuthenticated else { return }
        let activityID = activity.id
        let generation = deliveryLiveActivityGeneration
        if deliveryActivityPushTokenTasks[activityID] == nil {
            deliveryActivityPushTokenTasks[activityID] = Task { [weak self] in
                guard let self else { return }
                if let token = activity.pushToken {
                    await self.registerDeliveryActivityUpdateToken(
                        token,
                        activity: activity,
                        generation: generation
                    )
                }
                for await token in activity.pushTokenUpdates {
                    if Task.isCancelled { return }
                    await self.registerDeliveryActivityUpdateToken(
                        token,
                        activity: activity,
                        generation: generation
                    )
                }
            }
        }
        if deliveryActivityStateTasks[activityID] == nil {
            deliveryActivityStateTasks[activityID] = Task { [weak self] in
                guard let self else { return }
                for await state in activity.activityStateUpdates {
                    if Task.isCancelled { return }
                    guard state == .ended || state == .dismissed else { continue }
                    await self.unregisterDeliveryLiveActivity(activityID: activityID)
                    self.deliveryActivityPushTokenTasks[activityID]?.cancel()
                    self.deliveryActivityPushTokenTasks[activityID] = nil
                    self.deliveryActivityStateTasks[activityID] = nil
                    return
                }
            }
        }
    }

    private func registerCurrentDeliveryPushToStartToken() {
        guard let token = Activity<DeliveryActivityAttributes>.pushToStartToken else { return }
        let generation = deliveryLiveActivityGeneration
        Task { [weak self] in
            await self?.registerDeliveryPushToStartToken(token, generation: generation)
        }
    }

    private func registerCurrentDeliveryActivityUpdateTokens() {
        let generation = deliveryLiveActivityGeneration
        for activity in Activity<DeliveryActivityAttributes>.activities {
            guard let token = activity.pushToken else { continue }
            Task { [weak self] in
                await self?.registerDeliveryActivityUpdateToken(
                    token,
                    activity: activity,
                    generation: generation
                )
            }
        }
    }

    private func registerDeliveryPushToStartToken(
        _ token: Data,
        generation: Int
    ) async {
        guard generation == deliveryLiveActivityGeneration,
              deliveryLiveActivitiesEnabled,
              !deliveryLiveActivityRegistrationRemovalPending,
              !isDemo,
              session.isAuthenticated else { return }
        do {
            try await api.registerLiveActivityDevice(
                token: token.hexadecimalString,
                installationID: installationID,
                language: localizer.language
            )
            guard generation == deliveryLiveActivityGeneration else {
                if deliveryLiveActivityRegistrationRemovalPending {
                    try? await api.unregisterLiveActivityDevice(installationID: installationID)
                } else {
                    registerCurrentDeliveryPushToStartToken()
                }
                return
            }
            deliveryLiveActivityError = nil
        } catch {
            if generation == deliveryLiveActivityGeneration {
                deliveryLiveActivityError = localizer.errorMessage(error)
            }
        }
    }

    private func registerDeliveryActivityUpdateToken(
        _ token: Data,
        activity: Activity<DeliveryActivityAttributes>,
        generation: Int
    ) async {
        guard generation == deliveryLiveActivityGeneration,
              deliveryLiveActivitiesEnabled,
              !deliveryLiveActivityRegistrationRemovalPending,
              !isDemo,
              session.isAuthenticated else { return }
        do {
            try await api.registerLiveActivityUpdateToken(
                activityID: activity.id,
                parcelID: activity.attributes.parcelID,
                token: token.hexadecimalString,
                installationID: installationID,
                language: localizer.language
            )
            if generation == deliveryLiveActivityGeneration {
                deliveryLiveActivityError = nil
            }
        } catch {
            if generation == deliveryLiveActivityGeneration {
                deliveryLiveActivityError = localizer.errorMessage(error)
            }
        }
    }

    private func unregisterDeliveryLiveActivity(activityID: String) async {
        guard !isDemo, session.isAuthenticated else { return }
        try? await api.unregisterLiveActivityUpdateToken(
            activityID: activityID,
            installationID: installationID
        )
    }

    private func unregisterDeliveryLiveActivityDevice() async {
        guard !isDemo, session.isAuthenticated else { return }
        do {
            try await api.unregisterLiveActivityDevice(installationID: installationID)
            deliveryLiveActivityError = nil
        } catch {
            deliveryLiveActivityError = localizer.errorMessage(error)
        }
    }

    private func trimExcessDeliveryLiveActivities() async {
        var seen = Set<UUID>()
        var retained = 0
        for activity in Activity<DeliveryActivityAttributes>.activities {
            let parcelID = activity.attributes.parcelID
            guard activity.content.state.parcel.phase == .outForDelivery else { continue }
            if seen.contains(parcelID) || retained >= 2 {
                await endDeliveryLiveActivity(activity)
            } else {
                seen.insert(parcelID)
                retained += 1
            }
        }
    }

    private static func installationIdentifier(
        defaults: UserDefaults = .standard
    ) -> UUID {
        if let raw = defaults.string(forKey: installationIDKey), let value = UUID(uuidString: raw) {
            return value
        }
        let value = UUID()
        defaults.set(value.uuidString, forKey: installationIDKey)
        return value
    }

    private func beginPolling() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { return }
                if self.isActive { await self.load(showSpinner: false) }
            }
        }
    }

    private func monitorJobs(_ jobIDs: [UUID]) {
        pendingJobIDs.formUnion(jobIDs)
        guard jobMonitoringTask == nil, !pendingJobIDs.isEmpty else { return }
        jobMonitoringTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, !self.pendingJobIDs.isEmpty {
                let current = Array(self.pendingJobIDs)
                do {
                    try await self.api.waitForJobs(current)
                    self.pendingJobIDs.subtract(current)
                    await self.load(showSpinner: false)
                } catch {
                    if Task.isCancelled { break }
                    self.pendingJobIDs.subtract(current)
                    self.errorMessage = self.localizer.errorMessage(error)
                }
            }
            self.jobMonitoringTask = nil
            if !self.pendingJobIDs.isEmpty { self.monitorJobs([]) }
        }
    }

    private func waitForAPNSToken() async -> String? {
        if let existing = AppDelegate.currentDeviceToken { return existing }
        for _ in 0..<80 {
            try? await Task.sleep(for: .milliseconds(100))
            if let token = AppDelegate.currentDeviceToken { return token }
        }
        return nil
    }
}

private struct DemoExport: Encodable {
    let exportedAt: String
    let mode: String
    let packages: [Parcel]
}

private extension Data {
    var hexadecimalString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}

private struct ParcelCache {
    private let manager = FileManager.default

    func save(_ parcels: [Parcel], userID: UUID) throws {
        let url = try fileURL(userID: userID)
        let data = try JSONEncoder.deliveryTracker.encode(parcels)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func load(userID: UUID) -> [Parcel]? {
        guard let url = try? fileURL(userID: userID), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder.deliveryTracker.decode([Parcel].self, from: data)
    }

    func delete(userID: UUID) {
        guard let url = try? fileURL(userID: userID) else { return }
        try? manager.removeItem(at: url)
    }

    private func fileURL(userID: UUID) throws -> URL {
        let directory = try manager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appending(path: "ParcelCache", directoryHint: .isDirectory)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appending(path: "\(userID.uuidString).json")
    }
}

private final class DemoRepository {
    private let key = "sdt.native.demo.parcels.v1"
    private let preferencesKey = "sdt.native.demo.preferences.v1"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var notificationPreferences: NotificationPreferences {
        guard let data = defaults.data(forKey: preferencesKey),
              let value = try? JSONDecoder.deliveryTracker.decode(NotificationPreferences.self, from: data)
        else { return Self.defaultPreferences }
        return value
    }

    func saveNotificationPreferences(_ value: NotificationPreferences) -> NotificationPreferences {
        defaults.set(try? JSONEncoder.deliveryTracker.encode(value), forKey: preferencesKey)
        return value
    }

    func list() -> [Parcel] {
        load().sorted { $0.createdAt > $1.createdAt }
    }

    func add(_ request: CreatePackageRequest) throws -> Parcel {
        guard let carrier = request.carrier else { throw DeliveryAPIError.invalidResponse }
        var all = load()
        if all.contains(where: { $0.trackingNumber == request.trackingNumber }) {
            throw DeliveryAPIError.duplicateTracking
        }
        let id = UUID()
        let now = DateParser.isoString(Date())
        let event = TrackingEvent(
            id: UUID(), packageID: id, stage: .pending,
            description: "Tracking added; the carrier has not announced it yet",
            location: nil, occurredAt: now
        )
        let handoff = CarrierCatalog.supportsSwissPostHandoff(request.trackingNumber)
        let parcel = Parcel(
            id: id,
            trackingNumber: request.trackingNumber,
            label: request.label ?? "",
            carrier: carrier,
            createdAt: now,
            expectedDelivery: nil,
            lastStatusText: nil,
            lastSyncedAt: now,
            syncStatus: .ok,
            syncError: nil,
            trackingURL: request.trackingURL,
            dpdPostcode: request.dpdPostcode,
            carrierData: handoff ? CarrierData(activeTrackingCarrier: .aliexpress, swissPostReady: false) : nil,
            archivedAt: nil,
            notificationsMuted: false,
            trackingEvents: [event]
        )
        all.append(parcel)
        save(all)
        return parcel
    }

    func rename(id: UUID, label: String) throws -> Parcel {
        guard label.count <= 80 else { throw DeliveryAPIError.labelTooLong }
        return try update(id: id) { $0.label = label }
    }

    func setMuted(id: UUID, muted: Bool) throws -> Parcel {
        try update(id: id) { $0.notificationsMuted = muted }
    }

    func archive(id: UUID) throws {
        _ = try update(id: id) { $0.archivedAt = DateParser.isoString(Date()) }
    }

    func restore(id: UUID) throws -> Parcel {
        try update(id: id) { $0.archivedAt = nil }
    }

    func permanentlyDelete(id: UUID) throws {
        var all = load()
        guard all.contains(where: { $0.id == id }) else {
            throw DeliveryAPIError.parcelMissing
        }
        all.removeAll { $0.id == id }
        save(all)
    }

    func refreshAll() -> [Parcel] {
        let updated = load().map { advance($0) }
        save(updated)
        return updated.sorted { $0.createdAt > $1.createdAt }
    }

    func refresh(id: UUID) throws -> Parcel {
        try update(id: id) { $0 = advance($0) }
    }

    func reset() {
        defaults.removeObject(forKey: key)
        defaults.removeObject(forKey: preferencesKey)
    }

    private func load() -> [Parcel] {
        if let data = defaults.data(forKey: key),
           let parcels = try? JSONDecoder.deliveryTracker.decode([Parcel].self, from: data) {
            return parcels
        }
        let seeded = Self.seed()
        save(seeded)
        return seeded
    }

    private func save(_ parcels: [Parcel]) {
        defaults.set(try? JSONEncoder.deliveryTracker.encode(parcels), forKey: key)
    }

    private func update(id: UUID, change: (inout Parcel) -> Void) throws -> Parcel {
        var all = load()
        guard let index = all.firstIndex(where: { $0.id == id }) else {
            throw DeliveryAPIError.parcelMissing
        }
        change(&all[index])
        save(all)
        return all[index]
    }

    private func advance(_ parcel: Parcel) -> Parcel {
        guard parcel.isActive, let stage = parcel.currentStage, let next = Self.next(stage) else { return parcel }
        var copy = parcel
        let updates: [TrackingStage: (String, String?)] = [
            .registered: ("The sender announced the parcel", nil),
            .accepted: ("Parcel accepted at the counter", "Zürich-Mülligen"),
            .inTransit: ("Sorted at the parcel center", "Härkingen"),
            .outForDelivery: ("With the courier for delivery today", "Your neighbourhood"),
            .delivered: ("Delivered to your mailbox", "Home"),
            .readyForPickup: ("Ready for pickup at your branch", "Post branch"),
        ]
        let update = updates[next] ?? ("Tracking updated", nil)
        let timestamp = DateParser.isoString(Date())
        copy.trackingEvents.append(TrackingEvent(
            id: UUID(), packageID: copy.id, stage: next,
            description: update.0, location: update.1, occurredAt: timestamp
        ))
        copy.lastSyncedAt = timestamp
        copy.lastStatusText = update.0
        if CarrierCatalog.supportsSwissPostHandoff(copy.trackingNumber),
           [.inTransit, .customs, .outForDelivery, .delivered].contains(next) {
            copy.carrierData = CarrierData(activeTrackingCarrier: .swissPost, swissPostReady: true)
        }
        return copy
    }

    private static func next(_ stage: TrackingStage) -> TrackingStage? {
        switch stage {
        case .pending: .registered
        case .registered: .accepted
        case .accepted, .customs: .inTransit
        case .inTransit: .outForDelivery
        case .outForDelivery, .readyForPickup: .delivered
        case .failedAttempt: .readyForPickup
        case .delivered, .returned: nil
        }
    }

    private static let defaultPreferences = NotificationPreferences(
        enabledStages: [.registered, .accepted, .inTransit, .customs, .outForDelivery,
                        .failedAttempt, .readyForPickup, .delivered, .returned],
        quietHoursStart: nil,
        quietHoursEnd: nil,
        timezone: TimeZone.current.identifier
    )

    private static func seed() -> [Parcel] {
        let now = Date()
        func iso(hoursAgo: Double) -> String { DateParser.isoString(now.addingTimeInterval(-hoursAgo * 3_600)) }
        func event(_ id: UUID, _ stage: TrackingStage, _ hours: Double, _ text: String, _ place: String? = nil) -> TrackingEvent {
            TrackingEvent(id: UUID(), packageID: id, stage: stage, description: text, location: place, occurredAt: iso(hoursAgo: hours))
        }
        func parcel(
            label: String, number: String, carrier: CarrierID, created: Double,
            expected: String? = nil, events: (UUID) -> [TrackingEvent]
        ) -> Parcel {
            let id = UUID()
            let history = events(id)
            return Parcel(
                id: id, trackingNumber: number, label: label, carrier: carrier,
                createdAt: iso(hoursAgo: created), expectedDelivery: expected,
                lastStatusText: history.sorted(by: { $0.occurredAt > $1.occurredAt }).first?.description,
                lastSyncedAt: iso(hoursAgo: 0.2), syncStatus: .ok, syncError: nil,
                trackingURL: nil, dpdPostcode: carrier == .dpd ? "8004" : nil,
                carrierData: nil, archivedAt: nil, notificationsMuted: false,
                trackingEvents: history
            )
        }
        let today = ParcelOrganizer.dayKey(now)
        let tomorrow = ParcelOrganizer.dayKey(Calendar.current.date(byAdding: .day, value: 1, to: now)!)
        return [
            parcel(label: "Alpine running shoes 👟", number: "12345678901234", carrier: .dpd, created: 32, expected: "\(today) 14:10–16:10") { id in [
                event(id, .registered, 31, "Shipment data received"),
                event(id, .accepted, 22, "Parcel received by DPD", "Buchs AG"),
                event(id, .inTransit, 8, "At the sorting depot", "Mägenwil"),
                event(id, .outForDelivery, 1.5, "Out for delivery", "Zürich"),
            ] },
            parcel(label: "Birthday surprise 🎁", number: "993412345678901234", carrier: .swissPost, created: 74) { id in [
                event(id, .registered, 73, "The sender announced the parcel"),
                event(id, .accepted, 58, "Consignment posted", "Bern"),
                event(id, .inTransit, 18, "Sorted at the parcel center", "Härkingen"),
                event(id, .readyForPickup, 3, "Ready for collection", "Post branch 8004"),
            ] },
            parcel(label: "Coffee grinder ☕️", number: "1Z999AA10123456784", carrier: .ups, created: 48, expected: tomorrow) { id in [
                event(id, .registered, 47, "Label created"),
                event(id, .accepted, 39, "We have your package", "Milano, IT"),
                event(id, .inTransit, 5, "Departed from facility", "Bergamo, IT"),
            ] },
            parcel(label: "Camera strap", number: "RR123456785DE", carrier: .internationalPost, created: 138) { id in [
                event(id, .registered, 137, "Posting prepared"),
                event(id, .accepted, 130, "Accepted by origin post", "Hamburg, DE"),
                event(id, .customs, 10, "Awaiting customs clearance", "Basel"),
            ] },
            parcel(label: "Coffee beans", number: "443412345678901234", carrier: .quickpac, created: 96) { id in [
                event(id, .registered, 95, "Shipment announced"),
                event(id, .accepted, 80, "Parcel received"),
                event(id, .inTransit, 56, "In transit", "Dietikon"),
                event(id, .outForDelivery, 28, "Out for delivery"),
                event(id, .delivered, 26, "Delivered to your mailbox", "Home"),
            ] },
        ]
    }
}
