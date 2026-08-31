import SwiftUI
import UIKit

struct ParcelDetailView: View {
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
                        journey(parcel)
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
                        Button(
                            localizer.text(parcel.notificationsMuted ? "detail.unmute" : "detail.mute"),
                            systemImage: parcel.notificationsMuted ? "bell.fill" : "bell.slash"
                        ) {
                            run {
                                try await store.setMuted(parcel, muted: !parcel.notificationsMuted)
                            }
                        }
                        .disabled(working)
                        Divider()
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
        let trackingLinks = catalog.trackingLinks(for: parcel, language: localizer.language)

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
                    animated: false
                )
            }

            Divider()
                .overlay(tint.opacity(0.16))

            shipmentIdentity(parcel, links: trackingLinks, tint: tint)
            syncStatus(parcel, tint: tint)
        }
        .padding(22)
        .experimentalSurface(tint: tint, cornerRadius: 30)
        .experimentalGlassSheen(cornerRadius: 30, delay: 0.22)
        .accessibilityElement(children: .contain)
    }

    private func shipmentIdentity(
        _ parcel: Parcel,
        links: [ParcelTrackingLink],
        tint: Color
    ) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(localizer.text("detail.trackingNumber"))
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.35)
                    .foregroundStyle(.secondary)
                Text(CarrierCatalog.format(parcel.trackingNumber))
                    .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 4)

            Button {
                copy(parcel.trackingNumber)
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.caption.weight(.bold))
                    .frame(width: 32, height: 32)
                    .background(tint.opacity(0.11), in: Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(tint)
            .accessibilityLabel(localizer.text(copied ? "detail.copied" : "detail.copyTracking"))

            if let link = links.first {
                Link(destination: link.url) {
                    Image(systemName: "arrow.up.right")
                        .font(.caption.weight(.bold))
                        .frame(width: 32, height: 32)
                        .background(tint.opacity(0.11), in: Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(tint)
                .accessibilityLabel(localizer.text("detail.openCarrier", ["carrier": link.name]))
            }
        }
    }

    private func syncStatus(_ parcel: Parcel, tint: Color) -> some View {
        HStack(spacing: 7) {
            if let lastSyncedAt = parcel.lastSyncedAt {
                Image(systemName: "clock")
                    .font(.caption2.weight(.semibold))
                Text(localizer.relativeTime(from: lastSyncedAt))
            }

            if !parcel.isArchived {
                Button {
                    run { try await store.refresh(parcel) }
                } label: {
                    Group {
                        if working {
                            ProgressView()
                                .controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.caption.weight(.bold))
                        }
                    }
                    .frame(width: 27, height: 27)
                    .background(tint.opacity(0.11), in: Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(tint)
                .disabled(working)
                .accessibilityLabel(localizer.text("detail.checkNow"))
            }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
    }

    private func journey(_ parcel: Parcel) -> some View {
        let copy = ExperimentalCopy(language: localizer.language)
        let tint = ExperimentalPalette.tint(for: parcel)
        let currentEvent = parcel.sortedEvents.first
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

            if currentEvent == nil {
                Text(localizer.text(parcel.displayStatus.syncing ? "timeline.emptySyncing" : "timeline.empty"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    if let currentEvent {
                        ExperimentalCurrentTimelineRow(
                            event: currentEvent,
                            tint: tint,
                            hasFollowingEvent: !visibleEvents.isEmpty
                        )
                        .environmentObject(localizer)
                    }

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

private struct ExperimentalCurrentTimelineRow: View {
    let event: TrackingEvent
    let tint: Color
    let hasFollowingEvent: Bool

    @EnvironmentObject private var localizer: Localizer

    var body: some View {
        let strings = ExperimentalCopy(language: localizer.language)

        HStack(alignment: .top, spacing: 13) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(tint.opacity(0.16))
                    Circle().stroke(tint.opacity(0.22), lineWidth: 0.8)
                    Image(systemName: event.stage.metadata.symbol)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.primary)
                }
                .frame(width: 42, height: 42)

                if hasFollowingEvent {
                    Rectangle()
                        .fill(tint.opacity(0.2))
                        .frame(width: 2, height: 24)
                }
            }
            .frame(width: 42)

            VStack(alignment: .leading, spacing: 5) {
                Text(strings.currentUpdate)
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.4)
                    .foregroundStyle(tint)
                Text(localizer.text(event.stage.localizationKey))
                    .font(.title3.weight(.bold))
                Text(event.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text([event.location, localizer.dateTime(event.occurredAt)]
                    .compactMap { $0 }
                    .joined(separator: " · "))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, hasFollowingEvent ? 14 : 0)

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
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
            .frame(width: 42)

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
