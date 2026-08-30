import SwiftUI

struct ParcelListView: View {
    @EnvironmentObject private var localizer: Localizer
    @State private var selection = 0

    var body: some View {
        TabView(selection: $selection) {
            DeliveryListView()
                .tag(0)
                .tabItem {
                    Label(localizer.text("native.deliveries"), systemImage: "shippingbox.fill")
                }

            PassportView()
                .tag(1)
                .tabItem {
                    Label(ExperimentalCopy(language: localizer.language).passport, systemImage: "map.fill")
                }
        }
        .tint(Brand.ink)
        .sensoryFeedback(.selection, trigger: selection)
    }
}

private struct DeliveryListView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Namespace private var parcelTransition
    @State private var path: [UUID] = []
    @State private var query = ""
    @State private var statusFilter: ParcelStatusFilter = .all
    @State private var carrierFilter: CarrierID?
    @State private var sort: ParcelSort = .priority
    @State private var showingFilters = false
    @State private var showingAdd = false
    @State private var showingNotifications = false
    @State private var showingAccount = false
    @State private var archivedExpanded = false
    @State private var sharedDraft: SharedParcelDraft?
    @State private var actionMessage: String?
    @State private var actionError: String?

    private let catalog = CarrierCatalog.shared

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                ExperimentalBackdrop()
                content
            }
            .navigationTitle(localizer.text("native.deliveries"))
            .navigationBarTitleDisplayMode(.large)
            .toolbar { toolbar }
            .searchable(text: $query, prompt: localizer.text("view.searchPlaceholder"))
            .navigationDestination(for: UUID.self) { parcelID in
                ParcelDetailView(parcelID: parcelID, transition: parcelTransition)
            }
            .safeAreaInset(edge: .bottom, spacing: 8) { bottomControls }
        }
        .sheet(isPresented: $showingAdd) {
            AddParcelView(draft: sharedDraft)
                .environmentObject(store)
                .environmentObject(localizer)
        }
        .sheet(isPresented: $showingFilters) {
            ParcelFilterView(
                status: $statusFilter,
                carrier: $carrierFilter,
                sort: $sort,
                carriers: availableCarriers
            )
            .environmentObject(localizer)
        }
        .sheet(isPresented: $showingNotifications) {
            NotificationSettingsView()
                .environmentObject(store)
                .environmentObject(localizer)
        }
        .sheet(isPresented: $showingAccount) {
            AccountView()
                .environmentObject(store)
                .environmentObject(session)
                .environmentObject(localizer)
        }
        .alert(localizer.text("native.errorTitle"), isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button(localizer.text("common.close"), role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .onAppear {
            consumeSharedDraft()
            consumePendingParcelNotification()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            consumeSharedDraft()
        }
        .onReceive(NotificationCenter.default.publisher(for: .didOpenParcelNotification)) { notification in
            openParcelNotification(AppDelegate.consumePendingParcelID() ?? (notification.object as? UUID))
        }
        .onOpenURL(perform: handleURL)
        .onChange(of: store.undoParcel?.id) { _, next in
            guard let next else { return }
            Task {
                try? await Task.sleep(for: .seconds(7))
                if store.undoParcel?.id == next { store.undoParcel = nil }
            }
        }
    }

    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if !hasCustomView, let nextParcel {
                    Button { path.append(nextParcel.id) } label: {
                        ExperimentalNextDeliveryPass(parcel: nextParcel, transition: parcelTransition)
                    }
                    .buttonStyle(ExperimentalLiftButtonStyle())
                    .accessibilityHint(localizer.text("detail.label"))
                }

                if store.isDemo {
                    Label(localizer.text("app.demo"), systemImage: "sparkles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 11)
                        .frame(height: 30)
                        .background(.regularMaterial, in: Capsule())
                }

                if let message = store.errorMessage {
                    NoticeBanner(
                        symbol: "wifi.exclamationmark",
                        title: localizer.text(store.authenticationRequired ? "app.signInNeeded" : "app.trackingBreak"),
                        message: store.usingCachedData
                            ? "\(message) \(localizer.text("app.cachedData"))"
                            : message,
                        tint: .orange,
                        actionTitle: localizer.text(store.authenticationRequired ? "app.signInAgain" : "app.tryAgain"),
                        action: { Task { await store.load(showSpinner: true) } }
                    )
                }

                if hasCustomView { filterChips }

                if !store.loading && store.parcels.isEmpty {
                    ContentUnavailableView(
                        localizer.text("app.emptyTitle"),
                        systemImage: "shippingbox",
                        description: Text(localizer.text("app.emptyDescription"))
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 52)
                } else if !store.loading && visibleParcels.isEmpty {
                    ContentUnavailableView {
                        Label(localizer.text("view.noResultsTitle"), systemImage: "line.3.horizontal.decrease.circle")
                    } description: {
                        Text(localizer.text("view.noResultsDescription"))
                    } actions: {
                        Button(localizer.text("view.clear")) { clearFilters() }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                }

                ForEach(sections) { section in
                    sectionContent(section)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 106)
        }
        .scrollIndicators(.hidden)
        .refreshable {
            do {
                try await store.refreshAll()
                actionMessage = localizer.text("app.refreshQueued")
            } catch {
                actionError = localizer.errorMessage(error)
            }
        }
        .overlay {
            if store.loading && store.parcels.isEmpty {
                VStack(spacing: 12) {
                    ProgressView().controlSize(.large)
                    Text(localizer.text("app.opening"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { showingAccount = true } label: {
                if let email = session.user?.email, let initial = email.first {
                    Text(String(initial).uppercased())
                        .font(.caption.weight(.bold))
                        .frame(width: 30, height: 30)
                        .background(Brand.accent.opacity(0.25), in: Circle())
                } else {
                    Image(systemName: "person.crop.circle.fill")
                }
            }
            .tint(Brand.ink)
            .accessibilityLabel(localizer.text("account.signedIn"))
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { showingFilters = true } label: {
                Image(systemName: hasCustomView
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle")
            }
            .tint(Brand.ink)
            .accessibilityLabel(localizer.text("view.showControls"))

            Menu {
                Button(localizer.text("notifications.title"), systemImage: "bell") {
                    showingNotifications = true
                }
                Button(localizer.text("app.refresh"), systemImage: "arrow.clockwise") {
                    Task {
                        do {
                            try await store.refreshAll()
                            actionMessage = localizer.text("app.refreshQueued")
                        } catch {
                            actionError = localizer.errorMessage(error)
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .tint(Brand.ink)
        }
    }

    private var bottomControls: some View {
        VStack(spacing: 9) {
            if let parcel = store.undoParcel {
                InlineToast(
                    text: localizer.text("app.archivedToast", [
                        "name": parcel.label.nonEmpty ?? localizer.text("common.parcel"),
                    ]),
                    button: localizer.text("app.undo"),
                    symbol: "archivebox.fill",
                    tint: Brand.accent
                ) {
                    Task {
                        do { try await store.restore(parcel) }
                        catch { actionError = localizer.errorMessage(error) }
                    }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let actionMessage {
                InlineToast(
                    text: actionMessage,
                    button: nil,
                    symbol: "checkmark.circle.fill",
                    tint: .green,
                    action: nil
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task {
                    try? await Task.sleep(for: .seconds(4))
                    self.actionMessage = nil
                }
            }

            HStack {
                Spacer()
                experimentalAddButton
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 5)
        .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: store.undoParcel?.id)
        .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: actionMessage)
    }

    @ViewBuilder private var experimentalAddButton: some View {
        if #available(iOS 26.0, *) {
            addButtonIcon
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .controlSize(.extraLarge)
                .tint(Brand.accent)
        } else {
            addButtonIcon
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .controlSize(.large)
                .tint(Brand.accent)
        }
    }

    private var addButtonIcon: some View {
        Button {
            sharedDraft = nil
            showingAdd = true
        } label: {
            Image(systemName: "plus")
                .font(.title3.weight(.bold))
                .foregroundStyle(Brand.onAccent)
                .frame(width: 28, height: 28)
        }
        .accessibilityLabel(localizer.text("app.addParcelAria"))
    }

    private var visibleParcels: [Parcel] {
        ParcelOrganizer.visible(
            store.parcels,
            query: query,
            status: statusFilter,
            carrier: carrierFilter,
            sort: sort,
            catalog: catalog
        )
    }

    private var sections: [ParcelSection] {
        let organized = ParcelOrganizer.sections(from: visibleParcels)
        guard !hasCustomView, let highlighted = nextParcel?.id else { return organized }
        return organized.compactMap { section in
            let remaining = section.parcels.filter { $0.id != highlighted }
            return remaining.isEmpty ? nil : ParcelSection(kind: section.kind, parcels: remaining)
        }
    }

    private var availableCarriers: [CarrierID] {
        Array(Set(store.parcels.map(\.carrier))).sorted {
            catalog.info(for: $0).displayName < catalog.info(for: $1).displayName
        }
    }

    private var nextParcel: Parcel? {
        ParcelOrganizer.visible(
            store.parcels,
            query: "",
            status: .active,
            carrier: nil,
            sort: .priority,
            catalog: catalog
        ).first
    }

    private var hasCustomView: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || statusFilter != .all || carrierFilter != nil || sort != .priority
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    filterChip("“\(query)”") { query = "" }
                }
                if statusFilter != .all {
                    filterChip(localizer.text(statusFilter.localizationKey)) { statusFilter = .all }
                }
                if let carrierFilter {
                    filterChip(catalog.info(for: carrierFilter).displayName) { self.carrierFilter = nil }
                }
                if sort != .priority {
                    filterChip(localizer.text(sort.localizationKey)) { sort = .priority }
                }
                Button(localizer.text("view.clearAll")) { clearFilters() }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
            }
        }
    }

    private func filterChip(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).lineLimit(1)
                Image(systemName: "xmark").font(.caption2.weight(.bold))
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 11)
            .frame(height: 34)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(Brand.warning.opacity(0.25), lineWidth: 0.7))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Brand.ink)
    }

    private func sectionHeader(_ section: ParcelSection) -> some View {
        HStack(spacing: 9) {
            Text(sectionTitle(section.kind))
                .font(.title3.weight(.bold))
            Text("\(section.parcels.count)")
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(.secondary.opacity(0.09), in: Capsule())
            Spacer()
        }
        .padding(.top, 3)
    }

    @ViewBuilder private func sectionContent(_ section: ParcelSection) -> some View {
        switch section.kind {
        case .delivered:
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(section)
                ForEach(section.parcels) { parcel in
                    ExperimentalDeliveredParcelCard(
                        parcel: parcel,
                        transition: parcelTransition,
                        onOpen: { path.append(parcel.id) },
                        onArchive: { archive(parcel) }
                    )
                }
            }

        case .archived:
            if hasCustomView {
                VStack(alignment: .leading, spacing: 10) {
                    sectionHeader(section)
                    ExperimentalArchivedParcelGroup(
                        parcels: section.parcels,
                        transition: parcelTransition,
                        onOpen: { path.append($0) }
                    )
                }
            } else {
                ExperimentalArchiveShelf(
                    parcels: section.parcels,
                    isExpanded: $archivedExpanded,
                    transition: parcelTransition,
                    onOpen: { path.append($0) }
                )
            }

        default:
            VStack(alignment: .leading, spacing: 12) {
                sectionHeader(section)
                ForEach(section.parcels) { parcel in
                    ExperimentalParcelPassCard(
                        parcel: parcel,
                        notice: section.kind == .attention
                            ? parcel.attention().map { localizer.text($0.localizationKey) }
                            : nil,
                        transition: parcelTransition,
                        onOpen: { path.append(parcel.id) },
                        onArchive: parcel.isArchived ? nil : { archive(parcel) }
                    )
                }
            }
        }
    }

    private func sectionTitle(_ kind: ParcelSectionKind) -> String {
        switch kind {
        case .attention: localizer.text("app.needsAttention")
        case .today: localizer.text("app.arrivingToday")
        case .active: localizer.text("app.onTheWaySection")
        case .delivered: localizer.text("app.pastDeliveries")
        case .returned: localizer.text("app.returned")
        case .archived: localizer.text("app.archived")
        }
    }

    private func archive(_ parcel: Parcel) {
        Task {
            do { try await store.archive(parcel) }
            catch { actionError = localizer.errorMessage(error) }
        }
    }

    private func clearFilters() {
        query = ""
        statusFilter = .all
        carrierFilter = nil
        sort = .priority
    }

    private func consumeSharedDraft() {
        guard let draft = ShareInbox.consume() else { return }
        sharedDraft = draft
        showingAdd = true
    }

    private func consumePendingParcelNotification() {
        openParcelNotification(AppDelegate.consumePendingParcelID())
    }

    private func openParcelNotification(_ parcelID: UUID?) {
        guard let parcelID else { return }
        path = [parcelID]
    }

    private func handleURL(_ url: URL) {
        switch NativeRoute(url: url) {
        case .parcel(let parcelID):
            path = [parcelID]
        case .add(let trackingInput):
            sharedDraft = SharedParcelDraft(trackingInput: trackingInput)
            showingAdd = true
        case nil:
            break
        }
    }
}

private struct ExperimentalNextDeliveryPass: View {
    let parcel: Parcel
    let transition: Namespace.ID

    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    private let catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.tint(for: parcel)

        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 10) {
                ExperimentalStatusPill(
                    text: localizer.text(parcel.currentStage?.localizationKey ?? parcel.displayStatus.key),
                    symbol: parcel.currentStage?.metadata.symbol ?? "shippingbox.fill",
                    tint: tint,
                    isLive: parcel.currentStage == .outForDelivery
                )
                Spacer(minLength: 4)
                ExperimentalCarrierToken(carrier: catalog.info(for: parcel.activeTrackingCarrier), tint: tint)
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(localizer.text("app.nextUp"))
                    .font(.caption.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.8)
                    .foregroundStyle(.secondary)
                Text(parcel.expectedDelivery.map { localizer.expectedDelivery($0) }
                    ?? localizer.parcelStatus(parcel))
                    .font(.system(size: 31, weight: .heavy, design: .rounded))
                    .contentTransition(.numericText())
                    .lineLimit(2)
                    .minimumScaleFactor(0.76)
                Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                    .font(.title3.weight(.bold))
                    .lineLimit(2)
            }

            ExperimentalJourneyRail(stage: parcel.currentStage, tint: tint)
                .environmentObject(localizer)

            HStack(spacing: 8) {
                Image(systemName: "location.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(tint)
                Text(parcel.experimentalLatestLocation ?? catalog.info(for: parcel.activeTrackingCarrier).displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(parcel.lastSyncedAt.map { localizer.relativeTime(from: $0) } ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(22)
        .experimentalSurface(tint: tint, cornerRadius: 30)
        .experimentalGlassSheen(cornerRadius: 30)
        .opacity(appeared ? 1 : 0)
        .scaleEffect(appeared ? 1 : 0.975)
        .offset(y: appeared ? 0 : 12)
        .matchedTransitionSource(id: parcel.id, in: transition)
        .accessibilityElement(children: .combine)
        .onAppear {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.56)) {
                appeared = true
            }
        }
    }
}

private struct ExperimentalParcelPassCard: View {
    let parcel: Parcel
    let notice: String?
    let transition: Namespace.ID
    let onOpen: () -> Void
    let onArchive: (() -> Void)?

    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.tint(for: parcel)
        let motionReduced = reduceMotion

        HStack(spacing: 0) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        ExperimentalCarrierToken(
                            carrier: catalog.info(for: parcel.activeTrackingCarrier),
                            tint: tint
                        )
                        Spacer(minLength: 4)
                        HStack(spacing: 3) {
                            if parcel.currentStage == .outForDelivery {
                                ExperimentalLiveDot(tint: tint, size: 5)
                            }
                            Text(localizer.parcelStatus(parcel))
                                .lineLimit(1)
                        }
                        .font(.caption.weight(.bold))
                        .foregroundStyle(tint)
                    }

                    Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)

                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let expected = parcel.expectedDelivery, parcel.currentStage?.isFinal != true {
                            Text(localizer.expectedDelivery(expected))
                                .font(.headline.weight(.bold))
                                .foregroundStyle(.primary)
                        } else if let completed = localizer.parcelCompletionDate(parcel) {
                            Text(completed)
                                .font(.headline.weight(.bold))
                                .foregroundStyle(.primary)
                        }
                        Spacer(minLength: 0)
                        if let place = parcel.experimentalLatestLocation {
                            Label(place, systemImage: "location.fill")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if let notice {
                        Label(notice, systemImage: "exclamationmark.circle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                            .lineLimit(2)
                    }

                    if parcel.currentStage?.isFinal != true {
                        ExperimentalJourneyRail(stage: parcel.currentStage, tint: tint, compact: true)
                            .environmentObject(localizer)
                    }
                }
                .padding(.vertical, 17)
                .padding(.leading, 18)
                .padding(.trailing, onArchive == nil ? 18 : 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(ExperimentalLiftButtonStyle())

            if let onArchive {
                Menu {
                    Button(localizer.text("parcel.archive"), systemImage: "archivebox") {
                        onArchive()
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 54)
                }
                .accessibilityLabel(localizer.text("parcel.actionsAria", [
                    "name": parcel.label.nonEmpty ?? localizer.text("common.parcel"),
                ]))
            }
        }
        .experimentalSurface(tint: tint, cornerRadius: 24)
        .matchedTransitionSource(id: parcel.id, in: transition)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if let onArchive {
                Button(localizer.text("parcel.archive"), systemImage: "archivebox") { onArchive() }
                    .tint(.orange)
            }
        }
        .scrollTransition(.animated(.snappy(duration: 0.42))) { content, phase in
            content
                .opacity(motionReduced || phase.isIdentity ? 1 : 0.66)
                .scaleEffect(motionReduced || phase.isIdentity ? 1 : 0.975)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ExperimentalDeliveredParcelCard: View {
    let parcel: Parcel
    let transition: Namespace.ID
    let onOpen: () -> Void
    let onArchive: (() -> Void)?

    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    private let catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.delivered
        let motionReduced = reduceMotion

        HStack(spacing: 0) {
            Button(action: onOpen) {
                HStack(spacing: 13) {
                    ZStack {
                        Circle().fill(tint.opacity(0.15))
                        Circle().stroke(tint.opacity(0.22), lineWidth: 0.8)
                        Image(systemName: "checkmark")
                            .font(.subheadline.weight(.black))
                            .foregroundStyle(tint)
                            .symbolEffect(.bounce, value: appeared)
                    }
                    .frame(width: 40, height: 40)

                    VStack(alignment: .leading, spacing: 6) {
                        Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)

                        HStack(spacing: 6) {
                            Image(systemName: "shippingbox.fill")
                                .font(.caption2.weight(.bold))
                            Text(catalog.info(for: parcel.activeTrackingCarrier).displayName)
                                .lineLimit(1)
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: 4)

                    ExperimentalArrivalStamp(
                        date: parcel.experimentalCompletionDate,
                        label: localizer.text("stage.delivered"),
                        tint: tint
                    )
                }
                .padding(.vertical, 12)
                .padding(.leading, 14)
                .padding(.trailing, onArchive == nil ? 14 : 3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(ExperimentalLiftButtonStyle())

            if let onArchive {
                Menu {
                    Button(localizer.text("parcel.archive"), systemImage: "archivebox") {
                        onArchive()
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 38, height: 62)
                }
                .accessibilityLabel(localizer.text("parcel.actionsAria", [
                    "name": parcel.label.nonEmpty ?? localizer.text("common.parcel"),
                ]))
            }
        }
        .experimentalSurface(tint: tint, cornerRadius: 22, shadow: false)
        .matchedTransitionSource(id: parcel.id, in: transition)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if let onArchive {
                Button(localizer.text("parcel.archive"), systemImage: "archivebox") { onArchive() }
                    .tint(.orange)
            }
        }
        .scrollTransition(.animated(.snappy(duration: 0.4))) { content, phase in
            content
                .opacity(motionReduced || phase.isIdentity ? 1 : 0.72)
                .scaleEffect(motionReduced || phase.isIdentity ? 1 : 0.982)
        }
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 7)
        .onAppear {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.42)) {
                appeared = true
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ExperimentalArrivalStamp: View {
    let date: Date?
    let label: String
    let tint: Color

    @EnvironmentObject private var localizer: Localizer

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.caption2.weight(.bold))
                Text(label)
                    .lineLimit(1)
            }
            .font(.caption2.weight(.bold))
            .textCase(.uppercase)
            .tracking(0.35)
            .foregroundStyle(tint)

            if let date {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(datePart("d", from: date))
                        .font(.title2.weight(.black))
                        .monospacedDigit()
                    VStack(alignment: .leading, spacing: -2) {
                        Text(datePart("MMM", from: date).uppercased(with: localizer.language.locale))
                            .font(.caption2.weight(.bold))
                        Text(datePart("yyyy", from: date))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .foregroundStyle(.primary)
            } else {
                Text("—")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .frame(minWidth: 72, minHeight: 58, alignment: .trailing)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(tint.opacity(0.18), lineWidth: 0.7)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        guard let date else { return label }
        let formatter = DateFormatter()
        formatter.locale = localizer.language.locale
        formatter.dateStyle = .long
        return "\(label), \(formatter.string(from: date))"
    }

    private func datePart(_ template: String, from date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = localizer.language.locale
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }
}

private struct ExperimentalArchiveShelf: View {
    let parcels: [Parcel]
    @Binding var isExpanded: Bool
    let transition: Namespace.ID
    let onOpen: (UUID) -> Void

    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let copy = ExperimentalCopy(language: localizer.language)

        VStack(spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.38, extraBounce: 0.04)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 13) {
                    Image(systemName: "archivebox.fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 38, height: 38)
                        .background(.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(localizer.text("app.archived"))
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.primary)
                        Text(copy.archiveHint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 6)

                    Text("\(parcels.count)")
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 9)
                        .frame(height: 26)
                        .background(.secondary.opacity(0.09), in: Capsule())

                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(14)
                .contentShape(Rectangle())
            }
            .buttonStyle(ExperimentalLiftButtonStyle())
            .accessibilityLabel("\(localizer.text("app.archived")), \(parcels.count)")
            .accessibilityHint(isExpanded ? copy.hideArchive : copy.showArchive)

            if isExpanded {
                Divider().padding(.horizontal, 14)
                ForEach(Array(parcels.enumerated()), id: \.element.id) { index, parcel in
                    ExperimentalArchivedParcelRow(
                        parcel: parcel,
                        transition: transition,
                        onOpen: { onOpen(parcel.id) }
                    )
                    if index < parcels.count - 1 {
                        Divider().padding(.leading, 62)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .experimentalSurface(tint: .gray, cornerRadius: 24, shadow: false)
        .sensoryFeedback(.selection, trigger: isExpanded)
    }
}

private struct ExperimentalArchivedParcelGroup: View {
    let parcels: [Parcel]
    let transition: Namespace.ID
    let onOpen: (UUID) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(parcels.enumerated()), id: \.element.id) { index, parcel in
                ExperimentalArchivedParcelRow(
                    parcel: parcel,
                    transition: transition,
                    onOpen: { onOpen(parcel.id) }
                )
                if index < parcels.count - 1 {
                    Divider().padding(.leading, 62)
                }
            }
        }
        .experimentalSurface(tint: .gray, cornerRadius: 22, shadow: false)
    }
}

private struct ExperimentalArchivedParcelRow: View {
    let parcel: Parcel
    let transition: Namespace.ID
    let onOpen: () -> Void

    @EnvironmentObject private var localizer: Localizer
    private let catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.tint(for: parcel)

        Button(action: onOpen) {
            HStack(spacing: 12) {
                Image(systemName: parcel.currentStage?.metadata.symbol ?? "shippingbox.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(tint)
                    .frame(width: 34, height: 34)
                    .background(tint.opacity(0.11), in: Circle())

                VStack(alignment: .leading, spacing: 3) {
                    Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text("\(catalog.info(for: parcel.activeTrackingCarrier).displayName) · \(localizer.parcelStatus(parcel))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 6)

                if let date = parcel.experimentalArchivedDisplayDate {
                    Text(localizer.shortDate(date))
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 62)
            .contentShape(Rectangle())
        }
        .buttonStyle(ExperimentalLiftButtonStyle())
        .matchedTransitionSource(id: parcel.id, in: transition)
        .accessibilityElement(children: .combine)
    }
}

private extension Parcel {
    var experimentalCompletionDate: Date? {
        guard let event = currentEvent, event.stage.isFinal else { return nil }
        return DateParser.date(event.occurredAt)
    }

    var experimentalArchivedDisplayDate: Date? {
        experimentalCompletionDate ?? archivedAt.flatMap(DateParser.date)
    }
}

private struct PassportView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer

    private let catalog = CarrierCatalog.shared

    var body: some View {
        let copy = ExperimentalCopy(language: localizer.language)
        let stats = ExperimentalParcelStatistics(parcels: store.parcels)

        NavigationStack {
            ZStack {
                ExperimentalBackdrop()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        passportHero(stats: stats, copy: copy)

                        LazyVGrid(
                            columns: [GridItem(.flexible()), GridItem(.flexible())],
                            spacing: 12
                        ) {
                            metric(stats.deliveredCount, title: copy.delivered, symbol: "checkmark.circle.fill", tint: ExperimentalPalette.delivered)
                            metric(stats.activeCount, title: copy.active, symbol: "shippingbox.fill", tint: Brand.accent)
                            metric(stats.carrierCount, title: copy.carriers, symbol: "truck.box.fill", tint: ExperimentalPalette.transit)
                            metric(stats.placeCount, title: copy.places, symbol: "map.fill", tint: ExperimentalPalette.pickup)
                        }

                        if let favorite = stats.favoriteCarrier {
                            HStack(spacing: 14) {
                                Image(systemName: "sparkles")
                                    .font(.title2.weight(.bold))
                                    .foregroundStyle(Brand.onAccent)
                                    .frame(width: 46, height: 46)
                                    .background(Brand.accent, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(copy.carriers)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    Text(catalog.info(for: favorite).displayName)
                                        .font(.headline.weight(.bold))
                                }
                                Spacer()
                            }
                            .padding(17)
                            .experimentalSurface(tint: Brand.accent, cornerRadius: 22)
                        }

                        VStack(alignment: .leading, spacing: 12) {
                            Text(copy.memories)
                                .font(.title2.weight(.bold))
                            if stats.deliveredParcels.isEmpty {
                                ContentUnavailableView(
                                    copy.memories,
                                    systemImage: "shippingbox.and.arrow.backward",
                                    description: Text(copy.noMemories)
                                )
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 24)
                            } else {
                                ForEach(stats.deliveredParcels) { parcel in
                                    memory(parcel)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle(copy.passport)
            .navigationBarTitleDisplayMode(.large)
        }
    }

    private func passportHero(stats: ExperimentalParcelStatistics, copy: ExperimentalCopy) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(copy.yearInMotion, systemImage: "map.fill")
                .font(.caption.weight(.bold))
                .textCase(.uppercase)
                .tracking(0.75)
                .foregroundStyle(Brand.onAccent.opacity(0.68))
            Text("\(stats.trackedCount)")
                .font(.system(size: 58, weight: .black, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText())
            Text(copy.tracked)
                .font(.title2.weight(.bold))
        }
        .foregroundStyle(Brand.onAccent)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(24)
        .background(
            LinearGradient(
                colors: [Brand.accent, Brand.accent.opacity(0.76), ExperimentalPalette.pickup.opacity(0.82)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 30, style: .continuous)
        )
        .overlay(alignment: .topTrailing) {
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 74, weight: .black))
                .foregroundStyle(Brand.onAccent.opacity(0.09))
                .padding(24)
        }
        .shadow(color: Brand.accent.opacity(0.18), radius: 22, y: 12)
    }

    private func metric(_ value: Int, title: String, symbol: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: symbol)
                .font(.headline.weight(.bold))
                .foregroundStyle(tint)
                .frame(width: 36, height: 36)
                .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            Text("\(value)")
                .font(.system(.title, design: .rounded, weight: .bold))
                .monospacedDigit()
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 126, alignment: .topLeading)
        .padding(16)
        .experimentalSurface(tint: tint, cornerRadius: 22)
    }

    private func memory(_ parcel: Parcel) -> some View {
        let tint = ExperimentalPalette.tint(for: parcel)
        return HStack(spacing: 14) {
            Image(systemName: "checkmark")
                .font(.headline.weight(.black))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(tint, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                    .font(.headline.weight(.bold))
                Text([
                    catalog.info(for: parcel.carrier).displayName,
                    parcel.experimentalLatestLocation,
                    localizer.parcelCompletionDate(parcel),
                ].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .experimentalSurface(tint: tint, cornerRadius: 22, shadow: false)
    }
}
