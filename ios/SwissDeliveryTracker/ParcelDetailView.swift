import SwiftUI
import UIKit

struct ParcelDetailView: View {
    let parcelID: UUID
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @State private var editingTitle = false
    @State private var titleDraft = ""
    @State private var confirmingDelete = false
    @State private var working: Action?
    @State private var errorMessage: String?
    @State private var notice: String?
    @State private var copied = false

    private enum Action { case rename, check, archive, restore, delete, mute }
    private let catalog = CarrierCatalog.shared

    var body: some View {
        ZStack {
            Brand.background.ignoresSafeArea()
            if let parcel {
                ScrollView {
                    LazyVStack(spacing: 18) {
                        detailHero(parcel)
                        journey(parcel)
                        notificationSetting(parcel)
                        actions(parcel)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
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
        .toolbar {
            if let parcel {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(localizer.text("detail.editTitle"), systemImage: "pencil") {
                            titleDraft = parcel.label
                            editingTitle = true
                        }
                        Button(localizer.text("detail.copyTracking"), systemImage: "doc.on.doc") {
                            copy(parcel.trackingNumber)
                        }
                        if !parcel.isArchived {
                            Divider()
                            Button(localizer.text("detail.archive"), systemImage: "archivebox", role: .destructive) {
                                archive(parcel)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .alert(localizer.text("detail.editTitle"), isPresented: $editingTitle) {
            TextField(localizer.text("detail.titleAria"), text: $titleDraft)
            Button(localizer.text("common.cancel"), role: .cancel) {}
            Button(localizer.text("detail.saveTitle")) {
                guard let parcel else { return }
                run(.rename) { try await store.rename(parcel, label: titleDraft) }
            }
        }
        .alert(localizer.text("detail.deleteQuestion"), isPresented: $confirmingDelete) {
            Button(localizer.text("common.cancel"), role: .cancel) {}
            Button(localizer.text("detail.delete"), role: .destructive) {
                guard let parcel else { return }
                run(.delete) {
                    try await store.permanentlyDelete(parcel)
                    dismiss()
                }
            }
        } message: {
            Text(localizer.text("detail.deleteDescription"))
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

    private func detailHero(_ parcel: Parcel) -> some View {
        VStack(spacing: 16) {
            ZStack {
                Circle().fill(Color(hex: carrier(for: parcel).color).opacity(0.14))
                Image(systemName: parcel.currentStage?.metadata.symbol ?? "shippingbox")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(Color(hex: carrier(for: parcel).color))
            }
            .frame(width: 72, height: 72)

            VStack(spacing: 7) {
                Text(carrier(for: parcel).displayName)
                    .font(.caption.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(1.1)
                    .foregroundStyle(.secondary)
                Text(parcel.label.nonEmpty ?? localizer.text("common.parcel"))
                    .font(.system(.title, design: .rounded, weight: .bold))
                    .multilineTextAlignment(.center)
                StatusBadge(status: parcel.displayStatus)
            }

            DeliveryProgress(stage: parcel.currentStage)
                .padding(.horizontal, 12)

            trackingTicket(parcel)

            VStack(spacing: 6) {
                if let expected = parcel.expectedDelivery {
                    Label(
                        localizer.text("detail.expected", ["date": localizer.expectedDelivery(expected)]),
                        systemImage: "calendar"
                    )
                }
                if let checked = parcel.lastSyncedAt {
                    Label(
                        localizer.text("detail.lastChecked", ["date": localizer.dateTime(checked)]),
                        systemImage: "clock"
                    )
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if let syncError = parcel.syncError {
                NoticeBanner(
                    symbol: "exclamationmark.arrow.triangle.2.circlepath",
                    title: localizer.text("status.failed"),
                    message: syncError,
                    tint: .orange
                )
            }

            let links = catalog.trackingLinks(for: parcel, language: localizer.language)
            if !links.isEmpty {
                VStack(spacing: 8) {
                    ForEach(links) { link in
                        Link(destination: link.url) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(localizer.text("detail.openCarrier", ["carrier": link.name]))
                                        .font(.subheadline.weight(.semibold))
                                    if link.role != .active {
                                        Text(localizer.text(link.role == .waiting
                                            ? "detail.sourceWaiting" : "detail.sourceHistory"))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: "arrow.up.right.square")
                            }
                            .padding(.horizontal, 14)
                            .frame(minHeight: 48)
                            .background(.secondary.opacity(link.role == .active ? 0.1 : 0.055), in: RoundedRectangle(cornerRadius: 14))
                        }
                        .foregroundStyle(link.role == .active ? Brand.ink : .secondary)
                    }
                }
            }
        }
        .padding(20)
        .parcelCardSurface(tone: parcel.displayStatus.tone)
    }

    private func trackingTicket(_ parcel: Parcel) -> some View {
        VStack(spacing: 10) {
            HStack {
                Text(localizer.text("detail.trackingNumber"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(copied ? localizer.text("detail.copied") : localizer.text("detail.copy")) {
                    copy(parcel.trackingNumber)
                }
                .font(.caption.weight(.bold))
            }
            Text(CarrierCatalog.format(parcel.trackingNumber))
                .font(.system(.body, design: .monospaced, weight: .semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            BarcodeBars(seed: parcel.trackingNumber)
                .frame(height: 26)
                .opacity(0.78)
        }
        .padding(16)
        .background(Brand.cream, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(style: StrokeStyle(lineWidth: 1, dash: [5, 4])).foregroundStyle(.secondary.opacity(0.25)))
    }

    private func journey(_ parcel: Parcel) -> some View {
        VStack(alignment: .leading, spacing: 17) {
            VStack(alignment: .leading, spacing: 3) {
                Text(localizer.text("detail.history"))
                    .font(.caption.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(1)
                    .foregroundStyle(.secondary)
                Text(localizer.text("detail.journey"))
                    .font(.title2.weight(.bold))
            }
            if parcel.sortedEvents.isEmpty {
                Text(localizer.text(parcel.displayStatus.syncing ? "timeline.emptySyncing" : "timeline.empty"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 10)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(parcel.sortedEvents.enumerated()), id: \.element.id) { index, event in
                        TimelineRow(
                            event: event,
                            isCurrent: event.id == parcel.currentEvent?.id,
                            isLast: index == parcel.sortedEvents.count - 1
                        )
                        .environmentObject(localizer)
                    }
                }
            }
        }
        .padding(20)
        .parcelCardSurface()
    }

    private func notificationSetting(_ parcel: Parcel) -> some View {
        HStack(spacing: 14) {
            Image(systemName: parcel.notificationsMuted ? "bell.slash.fill" : "bell.fill")
                .foregroundStyle(parcel.notificationsMuted ? .secondary : Brand.accent)
                .frame(width: 38, height: 38)
                .background(.secondary.opacity(0.09), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(localizer.text("detail.mute")).font(.subheadline.weight(.semibold))
                Text(localizer.text("detail.muteDescription"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 5)
            Toggle("", isOn: Binding(
                get: { parcel.notificationsMuted },
                set: { muted in
                    run(.mute) { try await store.setMuted(parcel, muted: muted) }
                }
            ))
            .labelsHidden()
            .disabled(working != nil)
        }
        .padding(18)
        .parcelCardSurface()
    }

    private func actions(_ parcel: Parcel) -> some View {
        VStack(spacing: 11) {
            if let notice {
                NoticeBanner(
                    symbol: "checkmark.circle.fill",
                    title: notice,
                    message: "",
                    tint: .green
                )
            }
            if parcel.isArchived {
                Button {
                    run(.restore) {
                        try await store.restore(parcel)
                        dismiss()
                    }
                } label: {
                    actionLabel(
                        working == .restore ? localizer.text("common.restoring") : localizer.text("detail.restore"),
                        symbol: "arrow.uturn.backward",
                        busy: working == .restore
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(Brand.ink)

                Button(localizer.text("detail.delete"), systemImage: "trash", role: .destructive) {
                    confirmingDelete = true
                }
                .buttonStyle(.bordered)
                .tint(.red)
            } else {
                Button {
                    run(.check) {
                        try await store.refresh(parcel)
                        notice = localizer.text("detail.checkQueued")
                    }
                } label: {
                    actionLabel(
                        working == .check ? localizer.text("detail.queueing") : localizer.text("detail.checkNow"),
                        symbol: "arrow.clockwise",
                        busy: working == .check
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(Brand.accent)
                .foregroundStyle(Brand.ink)

                Button(localizer.text("detail.archive"), systemImage: "archivebox", role: .destructive) {
                    archive(parcel)
                }
                .buttonStyle(.bordered)
                .tint(.orange)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 22)
        .disabled(working != nil)
    }

    private func actionLabel(_ title: String, symbol: String, busy: Bool) -> some View {
        HStack {
            if busy { ProgressView() }
            else { Image(systemName: symbol) }
            Text(title)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 44)
    }

    private func carrier(for parcel: Parcel) -> CarrierDefinition {
        catalog.info(for: parcel.activeTrackingCarrier)
    }

    private func copy(_ value: String) {
        UIPasteboard.general.string = value
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    private func archive(_ parcel: Parcel) {
        run(.archive) {
            try await store.archive(parcel)
            dismiss()
        }
    }

    private func run(_ action: Action, operation: @escaping @MainActor () async throws -> Void) {
        guard working == nil else { return }
        working = action
        errorMessage = nil
        Task {
            do { try await operation() }
            catch { errorMessage = error.localizedDescription }
            working = nil
        }
    }
}

private struct TimelineRow: View {
    let event: TrackingEvent
    let isCurrent: Bool
    let isLast: Bool
    @EnvironmentObject private var localizer: Localizer

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(event.stage.metadata.tone.color.opacity(0.17))
                    Image(systemName: event.stage.metadata.symbol)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(event.stage.metadata.tone.color)
                }
                .frame(width: 30, height: 30)
                if !isLast {
                    Rectangle().fill(.secondary.opacity(0.15)).frame(width: 2, height: 58)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(localizer.text(event.stage.localizationKey))
                        .font(.subheadline.weight(isCurrent ? .bold : .semibold))
                    if isCurrent {
                        Text(localizer.text("native.latest"))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(event.stage.metadata.tone.color)
                    }
                }
                Text(event.description).font(.subheadline).foregroundStyle(.secondary)
                Text([event.location, localizer.dateTime(event.occurredAt)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.bottom, isLast ? 0 : 15)
            Spacer(minLength: 0)
        }
    }
}

private struct BarcodeBars: View {
    let seed: String

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                var x: CGFloat = 0
                let values = Array(seed.utf8)
                var index = 0
                while x < size.width {
                    let byte = values.isEmpty ? UInt8(3) : values[index % values.count]
                    let width = CGFloat((Int(byte) + index) % 3 + 1)
                    context.fill(
                        Path(CGRect(x: x, y: 0, width: width, height: size.height)),
                        with: .color(Brand.ink)
                    )
                    x += width + CGFloat((Int(byte) >> 2) % 3 + 1)
                    index += 1
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .accessibilityHidden(true)
    }
}
