import SwiftUI
import UIKit

struct ExperimentalParcelDetailView: View {
    let parcelID: UUID
    let transition: Namespace.ID

    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var showingFullJourney = false
    @State private var copied = false
    @State private var working = false
    @State private var errorMessage: String?

    private let catalog = CarrierCatalog.shared

    var body: some View {
        ZStack {
            ExperimentalBackdrop()
            if let parcel {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        liveParcelPass(parcel)
                        currentUpdate(parcel)
                        journey(parcel)
                        shipmentDetails(parcel)
                        notificationSetting(parcel)
                        primaryAction(parcel)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .padding(.bottom, 36)
                }
                .scrollIndicators(.hidden)
            } else {
                ContentUnavailableView(
                    localizer.text("common.parcel"),
                    systemImage: "shippingbox",
                    description: Text(localizer.text("native.parcelMissing"))
                )
            }
        }
        .navigationTitle(localizer.text("detail.label"))
        .navigationBarTitleDisplayMode(.inline)
        .navigationTransition(.zoom(sourceID: parcelID, in: transition))
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            if let parcel {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(localizer.text("detail.copyTracking"), systemImage: "doc.on.doc") {
                            copy(parcel.trackingNumber)
                        }
                        if parcel.isArchived {
                            Button(localizer.text("detail.restore"), systemImage: "arrow.uturn.backward") {
                                restore(parcel)
                            }
                        } else {
                            Button(localizer.text("detail.archive"), systemImage: "archivebox") {
                                archive(parcel)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                }
            }
        }
        .alert(localizer.text("native.errorTitle"), isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button(localizer.text("common.close"), role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var parcel: Parcel? { store.parcels.first { $0.id == parcelID } }

    private func liveParcelPass(_ parcel: Parcel) -> some View {
        let tint = ExperimentalPalette.tint(for: parcel)
        let strings = ExperimentalCopy(language: localizer.language)
        let carrier = catalog.info(for: parcel.activeTrackingCarrier)
        let origin = parcel.experimentalLatestLocation ?? carrier.displayName

        return VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 9) {
                ExperimentalStatusPill(
                    text: localizer.parcelStatus(parcel),
                    symbol: parcel.currentStage?.metadata.symbol ?? "shippingbox.fill",
                    tint: tint,
                    isLive: parcel.currentStage == .outForDelivery
                )
                Spacer(minLength: 4)
                ExperimentalCarrierToken(carrier: carrier, tint: tint)
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .lineLimit(2)
                Text(parcel.expectedDelivery.map { localizer.expectedDelivery($0) }
                    ?? localizer.parcelStatus(parcel))
                    .font(.system(size: 34, weight: .heavy, design: .rounded))
                    .contentTransition(.numericText())
                    .lineLimit(2)
                    .minimumScaleFactor(0.72)
            }

            VStack(spacing: 7) {
                HStack(spacing: 10) {
                    Label(origin, systemImage: "location.fill")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 12)
                    Label(strings.home, systemImage: "house.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(tint)
                }
                ExperimentalRouteLine(
                    tint: tint,
                    animated: parcel.currentStage?.isFinal != true
                )
            }

            ExperimentalJourneyRail(stage: parcel.currentStage, tint: tint)
                .environmentObject(localizer)

            if let lastSyncedAt = parcel.lastSyncedAt {
                Label(localizer.relativeTime(from: lastSyncedAt), systemImage: "clock")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(22)
        .experimentalSurface(tint: tint, cornerRadius: 30)
        .experimentalGlassSheen(cornerRadius: 30, delay: 0.22)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func currentUpdate(_ parcel: Parcel) -> some View {
        if let event = parcel.currentEvent {
            let tint = ExperimentalPalette.tint(for: parcel)
            let strings = ExperimentalCopy(language: localizer.language)

            VStack(alignment: .leading, spacing: 15) {
                Text(strings.currentUpdate)
                    .font(.title3.weight(.bold))

                HStack(alignment: .top, spacing: 14) {
                    ZStack {
                        if event.stage == .outForDelivery {
                            ExperimentalLiveDot(tint: tint, size: 22)
                        }
                        Image(systemName: event.stage.metadata.symbol)
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.primary)
                            .frame(width: 42, height: 42)
                            .background(tint.opacity(0.16), in: Circle())
                            .symbolEffect(.pulse, value: event.id)
                    }

                    VStack(alignment: .leading, spacing: 5) {
                        Text(localizer.text(event.stage.localizationKey))
                            .font(.headline.weight(.bold))
                        Text(event.description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            if let location = event.location {
                                Label(location, systemImage: "location.fill")
                            }
                            Text(localizer.dateTime(event.occurredAt))
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(19)
            .experimentalSurface(tint: tint, cornerRadius: 24)
        }
    }

    private func journey(_ parcel: Parcel) -> some View {
        let copy = ExperimentalCopy(language: localizer.language)
        let olderEvents = Array(parcel.sortedEvents.dropFirst())
        let visibleEvents = showingFullJourney ? olderEvents : Array(olderEvents.prefix(2))

        return VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(localizer.text("detail.journey"))
                    .font(.title2.weight(.bold))
                Spacer()
                if olderEvents.count > 2 {
                    Button(showingFullJourney ? copy.lessJourney : copy.fullJourney) {
                        withAnimation(reduceMotion ? nil : .snappy(duration: 0.34)) {
                            showingFullJourney.toggle()
                        }
                    }
                    .font(.caption.weight(.bold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Brand.ink)
                }
            }

            if visibleEvents.isEmpty {
                Text(localizer.text(parcel.displayStatus.syncing ? "timeline.emptySyncing" : "timeline.empty"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(visibleEvents.enumerated()), id: \.element.id) { index, event in
                        ExperimentalTimelineRow(
                            event: event,
                            isLast: index == visibleEvents.count - 1
                        )
                        .environmentObject(localizer)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
            }
        }
        .padding(20)
        .experimentalSurface(cornerRadius: 24, shadow: false)
    }

    private func shipmentDetails(_ parcel: Parcel) -> some View {
        let strings = ExperimentalCopy(language: localizer.language)
        let tint = ExperimentalPalette.tint(for: parcel)
        let links = catalog.trackingLinks(for: parcel, language: localizer.language)

        return DisclosureGroup {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(localizer.text("detail.trackingNumber"))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(CarrierCatalog.format(parcel.trackingNumber))
                            .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                            .textSelection(.enabled)
                    }
                    Spacer(minLength: 5)
                    Button {
                        copy(parcel.trackingNumber)
                    } label: {
                        Label(
                            copied ? localizer.text("detail.copied") : localizer.text("detail.copy"),
                            systemImage: copied ? "checkmark" : "doc.on.doc"
                        )
                    }
                    .font(.caption.weight(.bold))
                    .buttonStyle(.bordered)
                    .tint(Brand.ink)
                }
                .padding(.vertical, 14)

                ForEach(links) { link in
                    Link(destination: link.url) {
                        HStack {
                            Text(localizer.text("detail.openCarrier", ["carrier": link.name]))
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.caption.weight(.bold))
                        }
                        .frame(minHeight: 46)
                        .overlay(alignment: .top) {
                            Divider().overlay(Brand.separator.opacity(0.55))
                        }
                    }
                    .foregroundStyle(Brand.ink)
                }
            }
        } label: {
            Label(strings.shipmentDetails, systemImage: "shippingbox.and.arrow.backward")
                .font(.headline.weight(.bold))
                .foregroundStyle(.primary)
        }
        .tint(tint)
        .padding(18)
        .experimentalSurface(tint: tint, cornerRadius: 24, shadow: false)
    }

    private func notificationSetting(_ parcel: Parcel) -> some View {
        let tint = ExperimentalPalette.tint(for: parcel)
        return HStack(spacing: 14) {
            Image(systemName: parcel.notificationsMuted ? "bell.slash.fill" : "bell.fill")
                .font(.headline.weight(.bold))
                .foregroundStyle(parcel.notificationsMuted ? .secondary : tint)
                .frame(width: 40, height: 40)
                .background(tint.opacity(parcel.notificationsMuted ? 0.05 : 0.12), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(localizer.text("detail.notifications"))
                    .font(.subheadline.weight(.semibold))
                Text(localizer.text("detail.notificationsDescription"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 5)
            Toggle("", isOn: Binding(
                get: { !parcel.notificationsMuted },
                set: { enabled in
                    run { try await store.setMuted(parcel, muted: !enabled) }
                }
            ))
            .labelsHidden()
            .disabled(working)
        }
        .padding(18)
        .experimentalSurface(tint: tint, cornerRadius: 24, shadow: false)
    }

    @ViewBuilder private func primaryAction(_ parcel: Parcel) -> some View {
        if parcel.isArchived {
            Button {
                restore(parcel)
            } label: {
                actionLabel(
                    working ? localizer.text("common.restoring") : localizer.text("detail.restore"),
                    symbol: "arrow.uturn.backward"
                )
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(Brand.ink)
            .disabled(working)
        } else if #available(iOS 26.0, *) {
            checkButton(parcel)
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.extraLarge)
                .tint(Brand.accent)
                .disabled(working)
        } else {
            checkButton(parcel)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint(Brand.accent)
                .disabled(working)
        }
    }

    private func checkButton(_ parcel: Parcel) -> some View {
        Button {
            run { try await store.refresh(parcel) }
        } label: {
            actionLabel(
                working ? localizer.text("detail.queueing") : localizer.text("detail.checkNow"),
                symbol: "arrow.clockwise"
            )
            .foregroundStyle(Brand.onAccent)
        }
    }

    private func actionLabel(_ title: String, symbol: String) -> some View {
        HStack(spacing: 9) {
            if working { ProgressView() }
            else { Image(systemName: symbol) }
            Text(title)
        }
        .font(.headline)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 30)
    }

    private func copy(_ value: String) {
        UIPasteboard.general.string = value
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    private func archive(_ parcel: Parcel) {
        run {
            try await store.archive(parcel)
            dismiss()
        }
    }

    private func restore(_ parcel: Parcel) {
        run {
            try await store.restore(parcel)
            dismiss()
        }
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !working else { return }
        working = true
        errorMessage = nil
        Task {
            do { try await operation() }
            catch { errorMessage = localizer.errorMessage(error) }
            working = false
        }
    }
}

private struct ExperimentalTimelineRow: View {
    let event: TrackingEvent
    let isLast: Bool

    @EnvironmentObject private var localizer: Localizer

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(event.stage.metadata.tone.color.opacity(0.14))
                    Image(systemName: event.stage.metadata.symbol)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.primary)
                }
                .frame(width: 30, height: 30)
                if !isLast {
                    Rectangle()
                        .fill(.secondary.opacity(0.13))
                        .frame(width: 2, height: 56)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(localizer.text(event.stage.localizationKey))
                    .font(.subheadline.weight(.semibold))
                Text(event.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text([event.location, localizer.dateTime(event.occurredAt)]
                    .compactMap { $0 }
                    .joined(separator: " · "))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(.bottom, isLast ? 0 : 17)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
