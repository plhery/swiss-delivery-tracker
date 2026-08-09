import SwiftUI

struct ParcelListView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var localizer: Localizer
    @State private var path: [UUID] = []
    @State private var query = ""
    @State private var statusFilter: ParcelStatusFilter = .all
    @State private var carrierFilter: CarrierID?
    @State private var sort: ParcelSort = .priority
    @State private var showingFilters = false
    @State private var showingAdd = false
    @State private var showingNotifications = false
    @State private var showingAccount = false
    @State private var sharedDraft: SharedParcelDraft?
    @State private var archivedExpanded = false
    @State private var actionMessage: String?
    @State private var actionError: String?

    private let catalog = CarrierCatalog.shared

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Brand.background.ignoresSafeArea()
                parcelList
            }
            .navigationTitle(localizer.text("native.deliveries"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .automatic),
                prompt: localizer.text("view.searchPlaceholder")
            )
            .navigationDestination(for: UUID.self) { parcelID in
                ParcelDetailView(parcelID: parcelID)
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
            let parcelID = AppDelegate.consumePendingParcelID() ?? (notification.object as? UUID)
            openParcelNotification(parcelID)
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

    private var parcelList: some View {
        List {
            Section { hero.listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 6, trailing: 16)) }

            if store.isDemo {
                NoticeBanner(
                    symbol: "sparkles",
                    title: localizer.text("app.demo"),
                    message: localizer.text("app.demoDescription"),
                    tint: Brand.accent
                )
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
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
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            if !store.loading && store.parcels.isEmpty {
                ContentUnavailableView(
                    localizer.text("app.emptyTitle"),
                    systemImage: "shippingbox",
                    description: Text(localizer.text("app.emptyDescription"))
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .padding(.vertical, 42)
            } else if !store.loading && visibleParcels.isEmpty {
                ContentUnavailableView {
                    Label(localizer.text("view.noResultsTitle"), systemImage: "line.3.horizontal.decrease.circle")
                } description: {
                    Text(localizer.text("view.noResultsDescription"))
                } actions: {
                    Button(localizer.text("view.clear")) { clearFilters() }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .padding(.vertical, 30)
            }

            ForEach(sections) { section in
                Section {
                    if section.kind != .archived || archivedExpanded {
                        ForEach(section.parcels) { parcel in
                            ParcelCardView(
                                parcel: parcel,
                                notice: section.kind == .attention
                                    ? parcel.attention().map { localizer.text($0.localizationKey) }
                                    : nil,
                                onOpen: { path.append(parcel.id) }
                            )
                            .environmentObject(localizer)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if !parcel.isArchived {
                                    Button(localizer.text("parcel.archive"), systemImage: "archivebox", role: .destructive) {
                                        archive(parcel)
                                    }
                                    .tint(.orange)
                                }
                            }
                            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                        }
                    }
                } header: {
                    sectionHeader(section)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable {
            do {
                try await store.refreshAll()
                actionMessage = localizer.text("app.refreshQueued")
            } catch { actionError = error.localizedDescription }
        }
        .overlay {
            if store.loading && store.parcels.isEmpty {
                VStack(spacing: 12) {
                    ProgressView().controlSize(.large)
                    Text(localizer.text("app.opening"))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var hero: some View {
        HStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text(localizer.text("app.eyebrow"))
                    .font(.caption.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(1.2)
                    .foregroundStyle(Brand.ink.opacity(0.62))
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(store.loading ? "—" : "\(store.activeCount)")
                        .font(.system(size: 52, weight: .bold, design: .rounded))
                        .contentTransition(.numericText())
                    Text(localizer.text(store.activeCount == 1 ? "app.parcel.one" : "app.parcel.many"))
                        .font(.headline)
                }
                Text(localizer.text("app.onTheWay"))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Brand.ink.opacity(0.68))
            }
            Spacer(minLength: 8)
            ParcelGlyph(size: 76)
                .overlay(RoundedRectangle(cornerRadius: 19).stroke(Brand.ink.opacity(0.1)))
        }
        .foregroundStyle(Brand.ink)
        .padding(22)
        .background(
            LinearGradient(
                colors: [Brand.accentBright, Brand.accent],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 28, style: .continuous)
        )
        .overlay(alignment: .topTrailing) {
            Circle().stroke(Brand.ink.opacity(0.07), lineWidth: 24)
                .frame(width: 150, height: 150).offset(x: 42, y: -62)
                .allowsHitTesting(false)
        }
        .clipped()
        .shadow(color: Brand.ink.opacity(0.08), radius: 13, y: 7)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
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
                    Image(systemName: "person.crop.circle")
                }
            }
            .tint(Brand.ink)
            .accessibilityLabel(localizer.text("account.signedIn"))
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { showingNotifications = true } label: {
                Image(systemName: store.notificationsEnabledOnDevice ? "bell.badge.fill" : "bell")
            }
            .tint(Brand.ink)
            .accessibilityLabel(localizer.text("notifications.button"))
            Button { showingFilters = true } label: {
                Image(systemName: hasCustomView ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
            }
            .tint(Brand.ink)
            .accessibilityLabel(localizer.text("view.showControls"))
            Button {
                Task {
                    do {
                        try await store.refreshAll()
                        actionMessage = localizer.text("app.refreshQueued")
                    } catch { actionError = error.localizedDescription }
                }
            } label: {
                if store.refreshing { ProgressView().controlSize(.small) }
                else { Image(systemName: "arrow.clockwise") }
            }
            .disabled(store.refreshing)
            .tint(Brand.ink)
            .accessibilityLabel(localizer.text("app.refresh"))
        }
    }

    private var bottomControls: some View {
        VStack(spacing: 9) {
            if let parcel = store.undoParcel {
                InlineToast(
                    text: localizer.text("app.archivedToast", [
                        "name": parcel.label.nonEmpty ?? localizer.text("common.parcel"),
                    ]),
                    button: localizer.text("app.undo")
                ) {
                    Task {
                        do { try await store.restore(parcel) }
                        catch { actionError = error.localizedDescription }
                    }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let actionMessage {
                InlineToast(text: actionMessage, button: nil, action: nil)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        self.actionMessage = nil
                    }
            }

            HStack {
                Spacer()
                Button {
                    sharedDraft = nil
                    showingAdd = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(Brand.accentBright)
                        Text(localizer.text("app.addParcel"))
                            .font(.headline)
                            .foregroundStyle(Brand.paper)
                    }
                        .padding(.horizontal, 20)
                        .frame(height: 54)
                        .background(Brand.ink, in: Capsule())
                        .overlay(Capsule().stroke(.white.opacity(0.1), lineWidth: 0.7))
                        .shadow(color: Brand.ink.opacity(0.2), radius: 13, y: 7)
                }
                .buttonStyle(TactileButtonStyle(scale: 0.97))
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 5)
        .animation(.snappy, value: store.undoParcel?.id)
        .animation(.snappy, value: actionMessage)
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
        ParcelOrganizer.sections(from: visibleParcels)
    }

    private var availableCarriers: [CarrierID] {
        Array(Set(store.parcels.map(\.carrier))).sorted {
            catalog.info(for: $0).displayName < catalog.info(for: $1).displayName
        }
    }

    private var hasCustomView: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || statusFilter != .all || carrierFilter != nil || sort != .priority
    }

    @ViewBuilder
    private func sectionHeader(_ section: ParcelSection) -> some View {
        let title: String = {
            switch section.kind {
            case .attention: localizer.text("app.needsAttention")
            case .today: localizer.text("app.arrivingToday")
            case .active: localizer.text("app.onTheWaySection")
            case .delivered: localizer.text("app.pastDeliveries")
            case .returned: localizer.text("app.returned")
            case .archived: localizer.text("app.archived")
            }
        }()
        if section.kind == .archived {
            Button { withAnimation(.snappy) { archivedExpanded.toggle() } } label: {
                HStack {
                    Text(title)
                    CountPill(count: section.parcels.count)
                    Spacer()
                    Image(systemName: archivedExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.bold))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            HStack {
                Text(title)
                CountPill(count: section.parcels.count)
                Spacer()
            }
        }
    }

    private func archive(_ parcel: Parcel) {
        Task {
            do { try await store.archive(parcel) }
            catch { actionError = error.localizedDescription }
        }
    }

    private func clearFilters() {
        query = ""
        statusFilter = .all
        carrierFilter = nil
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
            consumeSharedDraft()
            if sharedDraft == nil {
                sharedDraft = SharedParcelDraft(trackingInput: trackingInput)
                showingAdd = true
            }
        case nil:
            break
        }
    }
}

private struct ParcelCardView: View {
    let parcel: Parcel
    let notice: String?
    let onOpen: () -> Void
    @EnvironmentObject private var localizer: Localizer
    private let catalog = CarrierCatalog.shared

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 13) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color(hex: carrier.color).opacity(0.14))
                    Image(systemName: parcel.currentStage?.metadata.symbol ?? "shippingbox")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Color(hex: carrier.color))
                }
                .frame(width: 48, height: 48)
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text(carrier.displayName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                        if let event = parcel.currentEvent {
                            Text(localizer.relativeTime(from: event.occurredAt))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(CarrierCatalog.format(parcel.trackingNumber))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    HStack(alignment: .center, spacing: 8) {
                        StatusBadge(status: parcel.displayStatus)
                        if let expected = parcel.expectedDelivery {
                            Text(localizer.text("parcel.expected", [
                                "date": localizer.expectedDelivery(expected),
                            ]))
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        }
                    }
                    if let notice {
                        Label(notice, systemImage: "exclamationmark.circle.fill")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.orange)
                            .lineLimit(2)
                    }
                    DeliveryProgress(stage: parcel.currentStage)
                        .padding(.top, 2)
                }
            }
            .padding(16)
            .contentShape(RoundedRectangle(cornerRadius: 21, style: .continuous))
            .parcelCardSurface(tone: parcel.displayStatus.tone)
        }
        .buttonStyle(TactileButtonStyle())
        .accessibilityElement(children: .combine)
    }

    private var carrier: CarrierDefinition {
        catalog.info(for: parcel.activeTrackingCarrier)
    }
}
