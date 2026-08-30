import SwiftUI
import UIKit
import VisionKit

struct ExperimentalAddParcelView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var label: String
    @State private var trackingInput: String
    @State private var trackingURL = ""
    @State private var deliveryPostcode = ""
    @State private var showingScanner = false
    @State private var saving = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private let catalog = CarrierCatalog.shared

    private enum Field: Hashable {
        case label
        case tracking
        case trackingURL
        case deliveryPostcode
    }

    init(draft: SharedParcelDraft?) {
        _label = State(initialValue: draft?.label ?? "")
        _trackingInput = State(initialValue: draft?.trackingInput ?? "")
    }

    var body: some View {
        NavigationStack {
            ZStack {
                ExperimentalBackdrop()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header
                        labelCard
                        trackingCard

                        if needsRequiredDetails {
                            requiredDetailsCard
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }

                        if let errorMessage {
                            errorBanner(errorMessage)
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
                    .padding(.bottom, 112)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localizer.text("common.cancel")) { dismiss() }
                        .disabled(saving)
                        .tint(Brand.ink)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                primaryAction
            }
            .interactiveDismissDisabled(saving)
            .animation(reduceMotion ? nil : .snappy(duration: 0.34), value: parsed.trackingNumber)
            .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: requirements)
            .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: errorMessage)
            .sensoryFeedback(.success, trigger: parsed.trackingNumber) { oldValue, newValue in
                oldValue.isEmpty && !newValue.isEmpty
            }
            .fullScreenCover(isPresented: $showingScanner) {
                TrackingScannerView { value in
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.34)) {
                        trackingInput = value
                        showingScanner = false
                    }
                    focusedField = nil
                }
                .environmentObject(localizer)
            }
            .onChange(of: resolvedCarrier, initial: true) { _, carrier in
                prepareRequiredDetails(for: carrier)
            }
            .task {
                guard focusedField == nil else { return }
                focusedField = label.isEmpty ? .label : .tracking
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        let strings = ExperimentalCopy(language: localizer.language)

        return HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle()
                    .fill(Brand.accent.opacity(0.18))
                    .frame(width: 54, height: 54)
                Image(systemName: "shippingbox.and.arrow.backward.fill")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Brand.ink)
                    .symbolEffect(.breathe, value: focusedField != nil)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(localizer.text("add.title"))
                    .font(.system(.title, design: .rounded, weight: .heavy))
                    .foregroundStyle(Brand.ink)
                Text(strings.quickAddIntro)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var labelCard: some View {
        let strings = ExperimentalCopy(language: localizer.language)

        return VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .firstTextBaseline) {
                Text(strings.parcelTitle)
                    .font(.headline.weight(.bold))
                Spacer()
                Text(localizer.text("add.optional"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Image(systemName: "tag.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.ink)
                    .frame(width: 42, height: 42)
                    .background(Brand.accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 13))

                TextField(
                    localizer.text("add.contentsPlaceholder"),
                    text: $label,
                    axis: .vertical
                )
                .font(.body.weight(.semibold))
                .lineLimit(1...2)
                .textContentType(.name)
                .submitLabel(.next)
                .focused($focusedField, equals: .label)
                .onSubmit { focusedField = .tracking }
                .onChange(of: label) { _, value in
                    if value.count > 80 { label = String(value.prefix(80)) }
                }
            }
        }
        .padding(18)
        .experimentalSurface(tint: Brand.accent, cornerRadius: 24, shadow: false)
    }

    private var trackingCard: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .center, spacing: 10) {
                Text(localizer.text("add.tracking"))
                    .font(.headline.weight(.bold))

                Spacer()

                Button(action: paste) {
                    Label(localizer.text("add.paste"), systemImage: "doc.on.clipboard")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Brand.ink.opacity(0.66))

                if scannerAvailable {
                    Button {
                        focusedField = nil
                        showingScanner = true
                    } label: {
                        Image(systemName: "barcode.viewfinder")
                            .font(.subheadline.weight(.semibold))
                            .frame(width: 26, height: 26)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Brand.ink.opacity(0.48))
                    .accessibilityLabel(localizer.text("add.scan"))
                }
            }

            HStack(alignment: .top, spacing: 9) {
                TextField(
                    localizer.text("add.trackingPlaceholder"),
                    text: $trackingInput,
                    axis: .vertical
                )
                .font(.system(.body, design: .monospaced))
                .lineLimit(1...4)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focusedField, equals: .tracking)
                .onSubmit(submitTracking)

                if !cleanedInput.isEmpty {
                    Button {
                        withAnimation(reduceMotion ? nil : .snappy) {
                            trackingInput = ""
                            errorMessage = nil
                        }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(localizer.text("view.clearAll"))
                }
            }
            .padding(.vertical, 3)

            if !parsed.trackingNumber.isEmpty {
                Divider().overlay(Brand.separator.opacity(0.5))
                detectionRow
                    .transition(.move(edge: .top).combined(with: .opacity))
            } else if !cleanedInput.isEmpty {
                Divider().overlay(Brand.separator.opacity(0.5))
                Label(localizer.text("add.notFound"), systemImage: "text.magnifyingglass")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(18)
        .experimentalSurface(tint: detectedTint, cornerRadius: 24)
    }

    private var detectionRow: some View {
        let strings = ExperimentalCopy(language: localizer.language)
        let definition = catalog.info(for: resolvedCarrier)

        return HStack(spacing: 11) {
            ZStack {
                Circle().fill(detectedTint.opacity(0.16))
                Image(systemName: "checkmark")
                    .font(.caption.weight(.heavy))
                    .foregroundStyle(detectedTint)
                    .symbolEffect(.bounce, value: parsed.trackingNumber)
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 2) {
                Text(strings.trackingReady)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(CarrierCatalog.format(parsed.trackingNumber))
                    .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            ExperimentalCarrierToken(carrier: definition, tint: detectedTint)
        }
        .accessibilityElement(children: .combine)
    }

    private var requiredDetailsCard: some View {
        let strings = ExperimentalCopy(language: localizer.language)

        return VStack(alignment: .leading, spacing: 14) {
            Label(strings.oneMoreDetail, systemImage: "sparkles")
                .font(.headline.weight(.bold))

            if let requirement = trackingURLRequirement,
               parsed.trackingURL == nil {
                requirementField(
                    title: localizer.text("add.requirement.trackingUrl"),
                    help: localizer.text("add.requirement.trackingUrlHelp")
                ) {
                    TextField(requirement.placeholder ?? "https://…", text: $trackingURL)
                        .font(.body)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .trackingURL)
                        .onChange(of: trackingURL) { _, value in
                            trackingURL = requirement.normalizedValue(value)
                        }
                }
            }

            if let requirement = postcodeRequirement {
                requirementField(
                    title: localizer.text("add.requirement.dpdPostcode"),
                    help: localizer.text("add.requirement.dpdPostcodeHelp")
                ) {
                    TextField(requirement.placeholder ?? "", text: $deliveryPostcode)
                        .font(.body.monospacedDigit())
                        .keyboardType(.numberPad)
                        .textContentType(.postalCode)
                        .focused($focusedField, equals: .deliveryPostcode)
                        .onChange(of: deliveryPostcode) { _, value in
                            deliveryPostcode = requirement.normalizedValue(value)
                        }
                }
            }
        }
        .padding(18)
        .experimentalSurface(tint: Brand.accent, cornerRadius: 24, shadow: false)
    }

    private func requirementField<FieldContent: View>(
        title: String,
        help: String,
        @ViewBuilder field: () -> FieldContent
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            field()
                .padding(12)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            Text(help)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message)
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(16)
        .experimentalSurface(tint: .red, cornerRadius: 20, shadow: false)
    }

    @ViewBuilder private var primaryAction: some View {
        if #available(iOS 26.0, *) {
            addButton
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.extraLarge)
                .tint(Brand.accent)
                .padding(.horizontal, 18)
                .padding(.vertical, 11)
                .background(.ultraThinMaterial)
        } else {
            addButton
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint(Brand.accent)
                .padding(.horizontal, 18)
                .padding(.vertical, 11)
                .background(.ultraThinMaterial)
        }
    }

    private var addButton: some View {
        Button(action: save) {
            HStack(spacing: 10) {
                if saving {
                    ProgressView().tint(Brand.onAccent)
                    Text(localizer.text("add.adding"))
                } else {
                    Image(systemName: "plus")
                        .fontWeight(.bold)
                    Text(localizer.text("app.addParcel"))
                }
            }
            .font(.headline)
            .foregroundStyle(Brand.onAccent)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 29)
            .contentTransition(.opacity)
        }
        .disabled(!canSave || saving)
    }

    private var cleanedInput: String {
        trackingInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    private var parsed: TrackingInputMatch { catalog.parse(trackingInput) }

    private var resolvedCarrier: CarrierID {
        if parsed.carrier != .unknown { return parsed.carrier }
        if parsed.candidates.count == 1, let carrier = parsed.candidates.first { return carrier }
        if let recent = store.parcels
            .sorted(by: { $0.createdAt > $1.createdAt })
            .first(where: { parsed.candidates.contains($0.carrier) }) {
            return recent.carrier
        }
        return .unknown
    }

    private var detectedTint: Color {
        resolvedCarrier == .unknown
            ? Brand.accent
            : Color(hex: catalog.info(for: resolvedCarrier).color)
    }

    private var requirements: [CarrierRequirement] {
        catalog.requirements(for: resolvedCarrier, trackingNumber: parsed.trackingNumber)
    }

    private var trackingURLRequirement: CarrierRequirement? {
        requirements.first(where: { $0.field == .trackingURL })
    }

    private var postcodeRequirement: CarrierRequirement? {
        requirements.first(where: { $0.field == .dpdPostcode })
    }

    private var needsRequiredDetails: Bool {
        (trackingURLRequirement != nil && parsed.trackingURL == nil)
            || postcodeRequirement != nil
    }

    private var canSave: Bool {
        guard !parsed.trackingNumber.isEmpty else { return false }
        for requirement in requirements {
            switch requirement.field {
            case .trackingURL:
                let value = requirement.normalizedValue(parsed.trackingURL ?? trackingURL)
                guard requirement.accepts(value),
                      let url = URL(string: value),
                      url.scheme == "https",
                      url.host != nil else { return false }
            case .dpdPostcode:
                guard requirement.accepts(deliveryPostcode) else { return false }
            }
        }
        return true
    }

    private func prepareRequiredDetails(for carrier: CarrierID) {
        guard postcodeRequirement != nil, deliveryPostcode.isEmpty else { return }
        let previous = store.parcels
            .sorted(by: { $0.createdAt > $1.createdAt })
            .first(where: { $0.carrier == carrier && $0.dpdPostcode != nil })?
            .dpdPostcode ?? ""
        deliveryPostcode = postcodeRequirement?.normalizedValue(previous) ?? ""
    }

    private func paste() {
        guard let value = UIPasteboard.general.string?.trimmingCharacters(
            in: .whitespacesAndNewlines
        ), !value.isEmpty else {
            errorMessage = localizer.text("add.pasteFailed")
            return
        }
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.34)) {
            errorMessage = nil
            trackingInput = value
        }
        focusedField = nil
    }

    private func submitTracking() {
        if let requirement = trackingURLRequirement,
           parsed.trackingURL == nil,
           !requirement.accepts(trackingURL) {
            focusedField = .trackingURL
        } else if let requirement = postcodeRequirement,
                  !requirement.accepts(deliveryPostcode) {
            focusedField = .deliveryPostcode
        } else if canSave {
            save()
        }
    }

    private func save() {
        guard canSave, !saving else { return }
        focusedField = nil
        saving = true
        errorMessage = nil

        Task {
            do {
                try await store.add(
                    trackingNumber: parsed.trackingNumber,
                    label: label,
                    carrier: resolvedCarrier,
                    trackingURL: trackingURLRequirement != nil
                        ? (parsed.trackingURL ?? trackingURL) : nil,
                    dpdPostcode: postcodeRequirement != nil ? deliveryPostcode : nil
                )
                dismiss()
            } catch {
                errorMessage = localizer.errorMessage(error)
                saving = false
            }
        }
    }
}
