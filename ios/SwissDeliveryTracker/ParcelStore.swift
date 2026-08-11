import Foundation
import UIKit
import UserNotifications

@MainActor
final class ParcelStore: ObservableObject {
    @Published private(set) var parcels: [Parcel] = []
    @Published private(set) var loading = false
    @Published private(set) var refreshing = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var authenticationRequired = false
    @Published private(set) var usingCachedData = false
    @Published private(set) var notificationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var notificationsEnabledOnDevice = false
    @Published private(set) var notificationPreferences: NotificationPreferences?
    @Published private(set) var notificationError: String?
    @Published var undoParcel: Parcel?

    let configuration: AppConfiguration
    private unowned let session: SessionStore
    private let api: DeliveryAPIClient
    private let demo: DemoRepository
    private let cache = ParcelCache()
    private var pollingTask: Task<Void, Never>?
    private var jobMonitoringTask: Task<Void, Never>?
    private var pendingJobIDs = Set<UUID>()
    private var isActive = true
    private var lastStartedAsDemo: Bool?
    private var notificationEnableInProgress = false
    private var nativePushGeneration = 0
    private let notificationOptOutKey = "sdt.notificationsDeviceOptOut"
    private let nativePushRegisteredKey = "sdt.notificationsNativePushRegistered.v1"
    private let demoNotificationsKey = "sdt.demoNotificationsEnabled"

    init(configuration: AppConfiguration = .current, session: SessionStore) {
        self.configuration = configuration
        self.session = session
        api = DeliveryAPIClient(configuration: configuration, session: session)
        demo = DemoRepository()
    }

    var isDemo: Bool { session.isDemo }
    var activeCount: Int { parcels.filter(\.isActive).count }
    var isSynchronizing: Bool {
        parcels.contains { $0.syncStatus == .pending || $0.syncStatus == .syncing }
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
        if !isDemo {
            await loadNotificationPreferences()
            beginPolling()
        }
    }

    func setActive(_ active: Bool) {
        isActive = active
        if active && session.isAuthenticated { Task { await load(showSpinner: false) } }
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
            errorMessage = error.localizedDescription
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
        let request = NewParcelRequest(
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
            monitorJobs(response.jobIds)
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
            return
        }
        nativePushGeneration += 1
        jobMonitoringTask?.cancel()
        pendingJobIDs.removeAll()
        try await api.deleteAccount(confirmation: confirmation)
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
        jobMonitoringTask?.cancel()
        pendingJobIDs.removeAll()
        if let token = AppDelegate.currentDeviceToken, !isDemo {
            try? await api.unregisterNativePushToken(token)
        }
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
        guard granted else { throw DeliveryAPIError.service("Notifications were not allowed.") }
        UserDefaults.standard.set(false, forKey: notificationOptOutKey)
        UIApplication.shared.registerForRemoteNotifications()
        if isDemo {
            UserDefaults.standard.set(true, forKey: demoNotificationsKey)
            notificationsEnabledOnDevice = true
            return true
        }
        guard let token = await waitForAPNSToken() else {
            throw DeliveryAPIError.service(
                "Apple did not return a notification token. Try again on a signed development build."
            )
        }
        let sent = try await api.registerNativePushToken(
            token,
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
            notificationError = error.localizedDescription
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
            notificationError = error.localizedDescription
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
                    self.errorMessage = error.localizedDescription
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

    func add(_ request: NewParcelRequest) throws -> Parcel {
        var all = load()
        if all.contains(where: { $0.trackingNumber == request.trackingNumber }) {
            throw DeliveryAPIError.service("This tracking number is already in your delivery box.")
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
            label: request.label,
            carrier: request.carrier,
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
        guard label.count <= 80 else { throw DeliveryAPIError.service("Parcel names can be at most 80 characters.") }
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
            throw DeliveryAPIError.service("Parcel not found.")
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
            throw DeliveryAPIError.service("Parcel not found.")
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
