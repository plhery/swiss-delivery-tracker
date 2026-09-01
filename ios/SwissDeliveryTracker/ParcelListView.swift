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

    @ObservedObject private var catalog = CarrierCatalog.shared

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
            AddParcelView(draft: sharedDraft) { parcelID in
                showingAdd = false
                path = [parcelID]
            }
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
                    ExperimentalNextDeliveryPass(
                        parcel: nextParcel,
                        transition: parcelTransition,
                        onOpen: { path.append(nextParcel.id) },
                        onArchive: { archive(nextParcel) }
                    )
                }

                if store.isDemo {
                    Label(localizer.text("app.demo"), systemImage: "sparkles")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
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
            Button {
                sharedDraft = nil
                showingAdd = true
            } label: {
                Image(systemName: "plus")
            }
            .tint(Brand.ink)
            .accessibilityLabel(localizer.text("app.addParcelAria"))

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

    @ViewBuilder private var bottomControls: some View {
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
            .padding(.horizontal, 16)
            .padding(.bottom, 5)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if let actionMessage {
            InlineToast(
                text: actionMessage,
                button: nil,
                symbol: "checkmark.circle.fill",
                tint: .green,
                action: nil
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 5)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task {
                try? await Task.sleep(for: .seconds(4))
                self.actionMessage = nil
            }
        }
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
    let onOpen: () -> Void
    let onArchive: () -> Void

    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @ObservedObject private var catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.tint(for: parcel)

        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 6) {
                Image(systemName: parcel.currentStage?.metadata.symbol ?? "shippingbox.fill")
                    .foregroundStyle(tint)
                Text(localizer.text(parcel.currentStage?.localizationKey ?? parcel.displayStatus.key))
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(catalog.info(for: parcel.activeTrackingCarrier).displayName)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)

            VStack(alignment: .leading, spacing: 4) {
                Text(localizer.text("app.nextUp"))
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(.secondary)
                Text(parcel.expectedDelivery.map { localizer.expectedDelivery($0) }
                    ?? localizer.parcelStatus(parcel))
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())
                    .lineLimit(2)
                    .minimumScaleFactor(0.76)
                Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                    .font(.headline.weight(.semibold))
                    .lineLimit(2)
            }

            ExperimentalJourneyRail(stage: parcel.currentStage, tint: tint)
                .environmentObject(localizer)

            HStack(spacing: 8) {
                Image(systemName: "location.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(tint)
                Text(parcel.experimentalLatestLocation
                    ?? catalog.info(for: parcel.activeTrackingCarrier).displayName)
                    .font(.subheadline)
                    .lineLimit(1)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(parcel.lastSyncedAt.map { localizer.relativeTime(from: $0) } ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
        }
        .padding(18)
        .experimentalSurface(tint: tint, cornerRadius: 24)
        .matchedTransitionSource(id: parcel.id, in: transition)
        .accessibilityElement(children: .combine)
        .experimentalSwipeToArchive(
            title: localizer.text("parcel.archive"),
            cornerRadius: 24,
            onOpen: onOpen,
            action: onArchive
        )
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 6)
        .accessibilityHint(localizer.text("detail.label"))
        .onAppear {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) {
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
    @ObservedObject private var catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.tint(for: parcel)

        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Text(localizer.parcelStatus(parcel))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tint)
                        .lineLimit(1)
                }

                HStack(spacing: 6) {
                    Text(catalog.info(for: parcel.activeTrackingCarrier).displayName)
                    if let expected = parcel.expectedDelivery, parcel.currentStage?.isFinal != true {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(localizer.expectedDelivery(expected))
                    } else if let completed = localizer.parcelCompletionDate(parcel) {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(completed)
                    }
                    if let place = parcel.experimentalLatestLocation {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(place)
                            .lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

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
            .padding(.vertical, 14)
            .padding(.leading, 15)
            .padding(.trailing, onArchive == nil ? 15 : 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())

            if let onArchive {
                Menu {
                    Button(localizer.text("parcel.archive"), systemImage: "archivebox") {
                        onArchive()
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 40, height: 50)
                }
                .accessibilityLabel(localizer.text("parcel.actionsAria", [
                    "name": parcel.label.nonEmpty ?? localizer.text("common.parcel"),
                ]))
            }
        }
        .experimentalSurface(cornerRadius: 18, shadow: false)
        .matchedTransitionSource(id: parcel.id, in: transition)
        .experimentalSwipeToArchive(
            title: localizer.text("parcel.archive"),
            cornerRadius: 18,
            shadow: false,
            protectedTrailingWidth: onArchive == nil ? 0 : 40,
            onOpen: onOpen,
            action: onArchive
        )
        .accessibilityElement(children: .contain)
    }
}

private struct ExperimentalDeliveredParcelCard: View {
    let parcel: Parcel
    let transition: Namespace.ID
    let onOpen: () -> Void
    let onArchive: (() -> Void)?

    @EnvironmentObject private var localizer: Localizer
    @ObservedObject private var catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.delivered

        HStack(spacing: 0) {
            HStack(spacing: 11) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(tint)
                    .frame(width: 30)

                VStack(alignment: .leading, spacing: 3) {
                    Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(catalog.info(for: parcel.activeTrackingCarrier).displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                if let date = parcel.experimentalCompletionDate {
                    Text(localizer.shortDate(date))
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 13)
            .padding(.leading, 15)
            .padding(.trailing, onArchive == nil ? 15 : 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())

            if let onArchive {
                Menu {
                    Button(localizer.text("parcel.archive"), systemImage: "archivebox") {
                        onArchive()
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 38, height: 54)
                }
                .accessibilityLabel(localizer.text("parcel.actionsAria", [
                    "name": parcel.label.nonEmpty ?? localizer.text("common.parcel"),
                ]))
            }
        }
        .experimentalSurface(cornerRadius: 18, shadow: false)
        .matchedTransitionSource(id: parcel.id, in: transition)
        .experimentalSwipeToArchive(
            title: localizer.text("parcel.archive"),
            cornerRadius: 18,
            shadow: false,
            protectedTrailingWidth: onArchive == nil ? 0 : 38,
            onOpen: onOpen,
            action: onArchive
        )
        .accessibilityElement(children: .contain)
    }
}

private extension View {
    func experimentalSwipeToArchive(
        title: String,
        cornerRadius: CGFloat,
        shadow: Bool = true,
        protectedTrailingWidth: CGFloat = 0,
        onOpen: @escaping () -> Void,
        action: (() -> Void)?
    ) -> some View {
        modifier(ExperimentalSwipeToArchiveModifier(
            title: title,
            cornerRadius: cornerRadius,
            shadow: shadow,
            protectedTrailingWidth: protectedTrailingWidth,
            onOpen: onOpen,
            action: action
        ))
    }
}

private struct ExperimentalSwipeToArchiveModifier: ViewModifier {
    let title: String
    let cornerRadius: CGFloat
    let shadow: Bool
    let protectedTrailingWidth: CGFloat
    let onOpen: () -> Void
    let action: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var dragOffset: CGFloat = 0
    @State private var restingOffset: CGFloat = 0
    @State private var width: CGFloat = 0
    @State private var archiveFeedback = 0

    private let actionWidth: CGFloat = 88

    @ViewBuilder
    func body(content: Content) -> some View {
        if let action {
            ZStack(alignment: .trailing) {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Brand.warning, Brand.warning.opacity(0.84)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .overlay(alignment: .trailing) {
                        Button {
                            trigger(action, provideFeedback: true)
                        } label: {
                            Label(title, systemImage: "archivebox.fill")
                                .labelStyle(.iconOnly)
                                .font(.system(size: 18, weight: .bold))
                                .scaleEffect(archiveIconScale)
                                .symbolEffect(.bounce, value: isCommitArmed)
                                .animation(
                                    reduceMotion
                                        ? nil
                                        : .snappy(duration: 0.22, extraBounce: 0.16),
                                    value: isCommitArmed
                                )
                                .foregroundStyle(.white)
                                .frame(width: max(actionWidth, revealedWidth))
                                .frame(maxHeight: .infinity)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHidden(revealedWidth < 8)
                    }
                    .opacity(revealProgress)

                content
                    .offset(x: currentOffset)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .shadow(
                color: shadow ? .black.opacity(0.08) : .clear,
                radius: shadow ? 18 : 0,
                y: shadow ? 9 : 0
            )
            .contentShape(Rectangle())
            .onGeometryChange(for: CGFloat.self) { geometry in
                geometry.size.width
            } action: { nextWidth in
                width = nextWidth
            }
            .simultaneousGesture(tapGesture, including: .gesture)
            .simultaneousGesture(swipeGesture(action: action), including: .gesture)
            .sensoryFeedback(
                .impact(weight: .medium, intensity: 0.9),
                trigger: isCommitArmed
            ) { wasArmed, isArmed in
                !wasArmed && isArmed
            }
            .sensoryFeedback(.impact(weight: .medium, intensity: 0.8), trigger: archiveFeedback)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { onOpen() }
        } else {
            content
                .contentShape(Rectangle())
                .onTapGesture(perform: onOpen)
                .accessibilityAddTraits(.isButton)
        }
    }

    private var currentOffset: CGFloat {
        max(-max(width, actionWidth), min(0, restingOffset + dragOffset))
    }

    private var revealProgress: CGFloat {
        min(1, max(0, -currentOffset / actionWidth))
    }

    private var revealedWidth: CGFloat {
        max(0, -currentOffset)
    }

    private var commitThreshold: CGFloat {
        max(actionWidth * 1.75, width * 0.52)
    }

    private var isCommitArmed: Bool {
        width > 0 && revealedWidth >= commitThreshold
    }

    private var archiveIconScale: CGFloat {
        let revealScale = 0.76 + (revealProgress * 0.24)
        return revealScale * (isCommitArmed ? 1.55 : 1)
    }

    private var tapGesture: some Gesture {
        SpatialTapGesture()
            .onEnded { value in
                handleTap(at: value.location)
            }
    }

    private func swipeGesture(action: @escaping () -> Void) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .updating($dragOffset) { value, state, _ in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                state = value.translation.width
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }

                let releasedOffset = max(
                    -max(width, actionWidth),
                    min(0, restingOffset + value.translation.width)
                )
                let projectedOffset = restingOffset + value.predictedEndTranslation.width
                if releasedOffset <= -commitThreshold {
                    trigger(action, provideFeedback: false)
                } else {
                    let shouldReveal = projectedOffset < -(actionWidth * 0.42)
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.3, extraBounce: 0.04)) {
                        restingOffset = shouldReveal ? -actionWidth : 0
                    }
                }
            }
    }

    private func handleTap(at location: CGPoint) {
        if restingOffset < -1 {
            guard location.x < width - revealedWidth else { return }
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.26, extraBounce: 0.03)) {
                restingOffset = 0
            }
            return
        }
        guard location.x < width - protectedTrailingWidth else { return }
        onOpen()
    }

    private func trigger(_ action: @escaping () -> Void, provideFeedback: Bool) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.28, extraBounce: 0.02)) {
            restingOffset = -max(width, actionWidth)
        }
        if provideFeedback { archiveFeedback += 1 }
        action()

        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(700))
            guard restingOffset <= -actionWidth else { return }
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.3, extraBounce: 0.04)) {
                restingOffset = 0
            }
        }
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

        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.3, extraBounce: 0.02)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "archivebox.fill")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(width: 22)

                    Text(localizer.text("app.archived"))
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.primary)

                    Spacer(minLength: 6)

                    CountPill(count: parcels.count)

                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(.vertical, 9)
                .padding(.horizontal, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(ExperimentalLiftButtonStyle())
            .accessibilityLabel("\(localizer.text("app.archived")), \(parcels.count)")
            .accessibilityHint(isExpanded ? copy.hideArchive : copy.showArchive)

            if isExpanded {
                VStack(spacing: 0) {
                    ForEach(Array(parcels.enumerated()), id: \.element.id) { index, parcel in
                        ExperimentalArchivedParcelRow(
                            parcel: parcel,
                            transition: transition,
                            onOpen: { onOpen(parcel.id) }
                        )
                        if index < parcels.count - 1 {
                            Divider().padding(.leading, 48)
                        }
                    }
                }
                .experimentalSurface(cornerRadius: 18, shadow: false)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
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
                    Divider().padding(.leading, 48)
                }
            }
        }
        .experimentalSurface(cornerRadius: 18, shadow: false)
    }
}

private struct ExperimentalArchivedParcelRow: View {
    let parcel: Parcel
    let transition: Namespace.ID
    let onOpen: () -> Void

    @EnvironmentObject private var localizer: Localizer
    @ObservedObject private var catalog = CarrierCatalog.shared

    var body: some View {
        let tint = ExperimentalPalette.tint(for: parcel)

        Button(action: onOpen) {
            HStack(spacing: 10) {
                Image(systemName: parcel.currentStage?.metadata.symbol ?? "shippingbox.fill")
                    .font(.subheadline)
                    .foregroundStyle(tint)
                    .frame(width: 28)

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
            .padding(.horizontal, 13)
            .frame(minHeight: 58)
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

    @ObservedObject private var catalog = CarrierCatalog.shared

    var body: some View {
        let copy = ExperimentalCopy(language: localizer.language)
        let stats = ExperimentalParcelStatistics(parcels: store.parcels)
        let recentDeliveries = Array(stats.deliveredParcels.prefix(5))

        NavigationStack {
            ZStack {
                ExperimentalBackdrop()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        passportHero(stats: stats, copy: copy)
                        passportFacts(stats: stats, copy: copy)

                        VStack(alignment: .leading, spacing: 12) {
                            Text(copy.memories)
                                .font(.title3.weight(.semibold))
                            if stats.deliveredParcels.isEmpty {
                                ContentUnavailableView(
                                    copy.memories,
                                    systemImage: "shippingbox.and.arrow.backward",
                                    description: Text(copy.noMemories)
                                )
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 24)
                            } else {
                                VStack(spacing: 0) {
                                    ForEach(Array(recentDeliveries.enumerated()), id: \.element.id) { index, parcel in
                                        memory(parcel)
                                        if index < recentDeliveries.count - 1 {
                                            Divider()
                                                .padding(.leading, 48)
                                        }
                                    }
                                }
                                .experimentalSurface(cornerRadius: 18, shadow: false)
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
        VStack(alignment: .leading, spacing: 17) {
            Label(copy.yearInMotion, systemImage: "map.fill")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .tracking(0.55)
                .foregroundStyle(Brand.onAccent.opacity(0.62))

            HStack(alignment: .lastTextBaseline, spacing: 9) {
                Text("\(stats.trackedCount)")
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(copy.tracked)
                    .font(.title3.weight(.semibold))
            }

            HStack(spacing: 0) {
                passportSummaryValue(stats.deliveredCount, title: copy.delivered)

                Rectangle()
                    .fill(Brand.onAccent.opacity(0.16))
                    .frame(width: 1, height: 32)
                    .padding(.horizontal, 18)

                passportSummaryValue(stats.activeCount, title: copy.active)
            }
        }
        .foregroundStyle(Brand.onAccent)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(
            LinearGradient(
                colors: [Brand.accent, ExperimentalPalette.pickup.opacity(0.72)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 26, style: .continuous)
        )
        .shadow(color: .black.opacity(0.045), radius: 10, y: 4)
    }

    private func passportSummaryValue(_ value: Int, title: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.headline.weight(.bold).monospacedDigit())
            Text(title)
                .font(.caption)
                .foregroundStyle(Brand.onAccent.opacity(0.62))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func passportFacts(stats: ExperimentalParcelStatistics, copy: ExperimentalCopy) -> some View {
        VStack(spacing: 0) {
            passportFact(
                symbol: "truck.box.fill",
                title: copy.carriers,
                value: "\(stats.carrierCount)",
                tint: ExperimentalPalette.transit
            )
            Divider().padding(.leading, 48)
            passportFact(
                symbol: "map.fill",
                title: copy.places,
                value: "\(stats.placeCount)",
                tint: ExperimentalPalette.pickup
            )

            if let favorite = stats.favoriteCarrier {
                Divider().padding(.leading, 48)
                passportFact(
                    symbol: "star.fill",
                    title: copy.mostUsedCarrier,
                    value: catalog.info(for: favorite).displayName,
                    tint: Brand.accent
                )
            }
        }
        .experimentalSurface(cornerRadius: 18, shadow: false)
    }

    private func passportFact(symbol: String, title: String, value: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 24)
            Text(title)
                .font(.subheadline)
            Spacer(minLength: 12)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 50)
    }

    private func memory(_ parcel: Parcel) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(ExperimentalPalette.delivered)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text([
                    catalog.info(for: parcel.carrier).displayName,
                    parcel.experimentalLatestLocation,
                ].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)

            if let date = parcel.experimentalCompletionDate {
                Text(localizer.shortDate(date))
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 58)
        .accessibilityElement(children: .combine)
    }
}
