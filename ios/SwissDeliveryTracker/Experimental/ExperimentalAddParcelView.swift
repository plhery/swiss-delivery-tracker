import SwiftUI
import UIKit

struct ExperimentalAddParcelView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var label: String
    @State private var trackingInput: String
    @State private var reviewDraft: SharedParcelDraft?
    @State private var parcelCountBeforeReview = 0
    @State private var pasteError = false
    @FocusState private var inputFocused: Bool

    private let catalog = CarrierCatalog.shared

    init(draft: SharedParcelDraft?) {
        _label = State(initialValue: draft?.label ?? "")
        _trackingInput = State(initialValue: draft?.trackingInput ?? "")
    }

    var body: some View {
        NavigationStack {
            ZStack {
                ExperimentalBackdrop()

                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        header
                        captureCard

                        if !parsed.trackingNumber.isEmpty {
                            detectedCard
                                .transition(.move(edge: .top).combined(with: .opacity))
                        } else if !cleanedInput.isEmpty {
                            notFoundCard
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }

                        labelCard
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
                    .padding(.bottom, 118)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localizer.text("common.cancel")) { dismiss() }
                        .tint(Brand.ink)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                bottomActions
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.34), value: parsed.trackingNumber)
            .sensoryFeedback(.success, trigger: parsed.trackingNumber) { oldValue, newValue in
                oldValue.isEmpty && !newValue.isEmpty
            }
            .alert(localizer.text("native.errorTitle"), isPresented: $pasteError) {
                Button(localizer.text("common.close"), role: .cancel) {}
            } message: {
                Text(localizer.text("add.pasteFailed"))
            }
            .fullScreenCover(item: $reviewDraft) { draft in
                AddParcelView(draft: draft)
                    .environmentObject(store)
                    .environmentObject(localizer)
            }
            .onChange(of: store.parcels.count) { _, newCount in
                guard reviewDraft != nil, newCount > parcelCountBeforeReview else { return }
                reviewDraft = nil
                dismiss()
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        let strings = ExperimentalCopy(language: localizer.language)

        return VStack(alignment: .leading, spacing: 10) {
            ZStack {
                Circle()
                    .fill(Brand.accent.opacity(0.18))
                    .frame(width: 64, height: 64)
                Image(systemName: "viewfinder.circle.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(Brand.ink)
                    .symbolEffect(.breathe, value: inputFocused)
            }

            Text(strings.smartCapture)
                .font(.system(.largeTitle, design: .rounded, weight: .heavy))
                .foregroundStyle(Brand.ink)
            Text(strings.scanOrEnter)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var captureCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(localizer.text("add.tracking"), systemImage: "sparkles")
                    .font(.headline.weight(.bold))
                Spacer()
                if !cleanedInput.isEmpty {
                    Button {
                        withAnimation(reduceMotion ? nil : .snappy) { trackingInput = "" }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(localizer.text("view.clearAll"))
                }
            }

            ZStack(alignment: .topLeading) {
                if cleanedInput.isEmpty {
                    Text(localizer.text("add.trackingPlaceholder"))
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                }

                TextEditor(text: $trackingInput)
                    .font(.system(.body, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 122)
                    .focused($inputFocused)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .accessibilityLabel(localizer.text("add.tracking"))
            }

            Divider().overlay(Brand.separator.opacity(0.5))

            Button(action: paste) {
                Label(localizer.text("add.paste"), systemImage: "doc.on.clipboard.fill")
                    .font(.subheadline.weight(.bold))
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(Brand.ink)
        }
        .padding(18)
        .experimentalSurface(tint: Brand.accent, cornerRadius: 26)
    }

    private var detectedCard: some View {
        let strings = ExperimentalCopy(language: localizer.language)
        let carrier = previewCarrier
        let definition = catalog.info(for: carrier)
        let tint = Color(hex: definition.color)

        return HStack(spacing: 14) {
            ZStack {
                Circle().fill(tint.opacity(0.17))
                Image(systemName: "checkmark")
                    .font(.headline.weight(.heavy))
                    .foregroundStyle(tint)
                    .symbolEffect(.bounce, value: parsed.trackingNumber)
            }
            .frame(width: 46, height: 46)

            VStack(alignment: .leading, spacing: 4) {
                Text(strings.ready)
                    .font(.headline.weight(.bold))
                Text(CarrierCatalog.format(parsed.trackingNumber))
                    .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                    .lineLimit(1)
                Text(strings.chooseNext)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 4)
            ExperimentalCarrierToken(carrier: definition, tint: tint)
        }
        .padding(18)
        .experimentalSurface(tint: tint, cornerRadius: 24, shadow: false)
        .accessibilityElement(children: .combine)
    }

    private var notFoundCard: some View {
        Label(localizer.text("add.notFound"), systemImage: "text.magnifyingglass")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .experimentalSurface(tint: Brand.warning, cornerRadius: 20, shadow: false)
    }

    private var labelCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Text(localizer.text("add.contents"))
                    .font(.headline.weight(.bold))
                Spacer()
                Text(localizer.text("add.optional"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Image(systemName: "shippingbox.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.ink)
                    .frame(width: 42, height: 42)
                    .background(Brand.accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 13))

                TextField(localizer.text("add.contentsPlaceholder"), text: $label)
                    .font(.body.weight(.semibold))
                    .onChange(of: label) { _, value in
                        if value.count > 80 { label = String(value.prefix(80)) }
                    }
            }
        }
        .padding(18)
        .experimentalSurface(cornerRadius: 24, shadow: false)
    }

    private var bottomActions: some View {
        HStack(spacing: 10) {
            Button {
                beginReview(trackingInput: "")
            } label: {
                Label(ExperimentalCopy(language: localizer.language).scanTitle, systemImage: "barcode.viewfinder")
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .frame(minHeight: 29)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(Brand.ink)

            primaryReviewButton
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder private var primaryReviewButton: some View {
        if #available(iOS 26.0, *) {
            reviewButton
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.extraLarge)
                .tint(Brand.accent)
        } else {
            reviewButton
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint(Brand.accent)
        }
    }

    private var reviewButton: some View {
        Button {
            beginReview(trackingInput: trackingInput)
        } label: {
            Label(ExperimentalCopy(language: localizer.language).continueTitle, systemImage: "arrow.right")
                .font(.headline)
                .foregroundStyle(Brand.onAccent)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 29)
        }
        .disabled(parsed.trackingNumber.isEmpty)
    }

    private var cleanedInput: String {
        trackingInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var parsed: TrackingInputMatch { catalog.parse(trackingInput) }

    private var previewCarrier: CarrierID {
        if parsed.carrier != .unknown { return parsed.carrier }
        return parsed.candidates.first ?? .unknown
    }

    private func paste() {
        guard let value = UIPasteboard.general.string?.trimmingCharacters(
            in: .whitespacesAndNewlines
        ), !value.isEmpty else {
            pasteError = true
            return
        }
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.34)) {
            trackingInput = value
        }
        inputFocused = false
    }

    private func beginReview(trackingInput: String) {
        parcelCountBeforeReview = store.parcels.count
        reviewDraft = SharedParcelDraft(label: label, trackingInput: trackingInput)
    }
}
