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

    @ObservedObject private var catalog = CarrierCatalog.shared

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
        let carrier = catalog.info(for: parcel.activeTrackingCarrier)
        let trackingLinks = catalog.trackingLinks(for: parcel, language: localizer.language)

        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 6) {
                Image(systemName: parcel.currentStage?.metadata.symbol ?? "shippingbox.fill")
                    .foregroundStyle(tint)
                Text(localizer.parcelStatus(parcel))
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(carrier.displayName)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)

            VStack(alignment: .leading, spacing: 5) {
                Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                    .font(.title2.weight(.semibold))
                    .lineLimit(2)
                Text(parcel.expectedDelivery.map { localizer.expectedDelivery($0) }
                    ?? localizer.parcelStatus(parcel))
                    .font(.title3.weight(.bold))
                    .contentTransition(.numericText())
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }

            if let location = parcel.experimentalLatestLocation {
                Label(location, systemImage: "location.fill")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Divider()

            shipmentIdentity(parcel, links: trackingLinks, tint: tint)
            syncStatus(parcel, tint: tint)
        }
        .padding(18)
        .experimentalSurface(tint: tint, cornerRadius: 24)
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
                    .font(.caption)
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
                    .frame(width: 30, height: 30)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(tint)
            .accessibilityLabel(localizer.text(copied ? "detail.copied" : "detail.copyTracking"))

            if let link = links.first {
                Link(destination: link.url) {
                    Image(systemName: "arrow.up.right")
                        .font(.caption.weight(.bold))
                        .frame(width: 30, height: 30)
                        .contentShape(Circle())
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
                    .frame(width: 26, height: 26)
                    .contentShape(Circle())
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

        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(localizer.text("detail.journey"))
                    .font(.headline.weight(.semibold))
                Spacer()
                if olderEvents.count > 2 {
                    Button(showingFullJourney ? copy.lessJourney : copy.fullJourney) {
                        withAnimation(reduceMotion ? nil : .snappy(duration: 0.34)) {
                            showingFullJourney.toggle()
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
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
        .padding(16)
        .experimentalSurface(cornerRadius: 18, shadow: false)
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

        HStack(alignment: .top, spacing: 11) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(tint.opacity(0.13))
                    Image(systemName: event.stage.metadata.symbol)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(tint)
                }
                .frame(width: 34, height: 34)

                if hasFollowingEvent {
                    Rectangle()
                        .fill(tint.opacity(0.16))
                        .frame(width: 1, height: 24)
                }
            }
            .frame(width: 34)

            VStack(alignment: .leading, spacing: 4) {
                Text(strings.currentUpdate)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                Text(localizer.text(event.stage.localizationKey))
                    .font(.headline.weight(.semibold))
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
        HStack(alignment: .top, spacing: 11) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(event.stage.metadata.tone.color.opacity(0.11))
                    Image(systemName: event.stage.metadata.symbol)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                .frame(width: 26, height: 26)
                if !isLast {
                    Rectangle()
                        .fill(.secondary.opacity(0.12))
                        .frame(width: 1, height: 54)
                }
            }
            .frame(width: 34)

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
