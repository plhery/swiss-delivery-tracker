import SwiftUI
import UIKit
import VisionKit

struct AddParcelView: View {
    let draft: SharedParcelDraft?
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @State private var label: String
    @State private var trackingInput: String
    @State private var selectedCarrier = "auto"
    @State private var showingCarrierPicker = false
    @State private var showingScanner = false
    @State private var trackingURL = ""
    @State private var dpdPostcode = ""
    @State private var saving = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private let catalog = CarrierCatalog.shared

    private enum Field: Hashable {
        case label
        case tracking
        case trackingURL
        case dpdPostcode
    }

    init(draft: SharedParcelDraft?) {
        self.draft = draft
        _label = State(initialValue: draft?.label ?? "")
        _trackingInput = State(initialValue: draft?.trackingInput ?? "")
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Brand.background.ignoresSafeArea()

                GeometryReader { geometry in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 24) {
                            header
                            contentsSection
                            trackingSection

                            if let definition = resolvedDefinition,
                               !parsed.trackingNumber.isEmpty {
                                carrierSection(definition)
                                    .transition(.move(edge: .top).combined(with: .opacity))
                            }

                            if requirements.contains(where: { $0.field == .trackingURL }),
                               parsed.trackingURL == nil {
                                trackingURLSection
                                    .transition(.move(edge: .top).combined(with: .opacity))
                            }

                            if requirements.contains(where: { $0.field == .dpdPostcode }) {
                                dpdPostcodeSection
                                    .transition(.move(edge: .top).combined(with: .opacity))
                            }

                            if let errorMessage {
                                errorBanner(errorMessage)
                                    .transition(.move(edge: .top).combined(with: .opacity))
                            }
                        }
                        .padding(.top, 12)
                        .padding(.bottom, 24)
                        .frame(width: max(0, geometry.size.width - 40), alignment: .leading)
                        .padding(.horizontal, 20)
                    }
                    .scrollDismissesKeyboard(.interactively)
                }
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
            .animation(.snappy(duration: 0.34), value: parsed.trackingNumber)
            .animation(.snappy(duration: 0.34), value: selectedCarrier)
            .animation(.snappy(duration: 0.3), value: errorMessage)
            .sensoryFeedback(.success, trigger: canSave) { oldValue, newValue in
                !oldValue && newValue
            }
            .onAppear {
                if dpdPostcode.isEmpty {
                    dpdPostcode = store.parcels
                        .sorted { $0.createdAt > $1.createdAt }
                        .first(where: { $0.carrier == .dpd && $0.dpdPostcode != nil })?
                        .dpdPostcode ?? ""
                }
            }
            .fullScreenCover(isPresented: $showingScanner) {
                TrackingScannerView { value in
                    withAnimation(.snappy) {
                        trackingInput = value
                        showingScanner = false
                    }
                }
                .environmentObject(localizer)
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(localizer.text("add.title"))
                .font(.largeTitle.bold())
                .foregroundStyle(Brand.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(localizer.text("add.intro"))
                .font(.body)
                .foregroundStyle(Brand.ink.opacity(0.68))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var contentsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(localizer.text("add.contents"), optional: true)

            HStack(spacing: 13) {
                Image(systemName: "shippingbox.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Brand.onAccent)
                    .frame(width: 42, height: 42)
                    .background(Brand.accentBright, in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                TextField(
                    "",
                    text: $label,
                    prompt: Text(localizer.text("add.contentsPlaceholder"))
                        .font(.body)
                        .foregroundColor(Brand.ink.opacity(0.5)),
                    axis: .vertical
                )
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Brand.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(1...2)
                    .textContentType(.name)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .label)
                    .accessibilityLabel(localizer.text("add.contents"))
                    .onSubmit { focusedField = .tracking }
                    .onChange(of: label) { _, value in
                        if value.count > 80 { label = String(value.prefix(80)) }
                    }
            }
            .padding(16)
            .addParcelCardSurface()
        }
    }

    private var trackingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(localizer.text("add.tracking"))

            VStack(alignment: .leading, spacing: 14) {
                TextField(
                    localizer.text("add.trackingPlaceholder"),
                    text: $trackingInput,
                    axis: .vertical
                )
                .font(.body.monospaced())
                .foregroundStyle(Brand.ink)
                .lineLimit(3...6)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .tracking)

                Divider().overlay(Brand.ink.opacity(0.12))

                quickActions

                if !trackingInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   parsed.trackingNumber.isEmpty {
                    validationMessage(
                        localizer.text("add.notFound"),
                        symbol: "exclamationmark.circle.fill",
                        tint: Brand.warning
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                if !parsed.trackingNumber.isEmpty,
                   parsed.source == .link || parsed.source == .text {
                    validationMessage(
                        "\(localizer.text("add.foundPrefix")) \(CarrierCatalog.format(parsed.trackingNumber)) \(localizer.text(parsed.source == .link ? "add.foundLinkSuffix" : "add.foundTextSuffix"))",
                        symbol: "checkmark.circle.fill",
                        tint: .green
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(16)
            .addParcelCardSurface()
        }
    }

    @ViewBuilder
    private var quickActions: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 10) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        quickActionButtons
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        quickActionButtons
                    }
                }
                .buttonStyle(.glass)
            }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    quickActionButtons
                }
                VStack(alignment: .leading, spacing: 10) {
                    quickActionButtons
                }
            }
            .buttonStyle(.bordered)
        }
    }

    @ViewBuilder
    private var quickActionButtons: some View {
        quickActionButton(
            localizer.text("add.paste"),
            systemImage: "doc.on.clipboard",
            action: pasteTrackingInput
        )

        if scannerAvailable {
            quickActionButton(
                localizer.text("add.scan"),
                systemImage: "barcode.viewfinder"
            ) {
                showingScanner = true
            }
        }
    }

    private func quickActionButton(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(title, systemImage: systemImage, action: action)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Brand.ink)
            .tint(Brand.ink)
            .buttonBorderShape(.capsule)
            .controlSize(.regular)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
    }

    private func carrierSection(_ definition: CarrierDefinition) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(localizer.text(
                selectedCarrier == "auto" ? "add.detectedCarrier" : "add.carrier"
            ))

            VStack(spacing: 14) {
                HStack(spacing: 13) {
                    Image(systemName: "shippingbox.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                        .frame(width: 42, height: 42)
                        .background(
                            Color(hex: definition.color).opacity(0.24),
                            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                        )
                        .overlay(alignment: .bottomTrailing) {
                            Circle()
                                .fill(Color(hex: definition.color))
                                .frame(width: 10, height: 10)
                                .overlay(Circle().stroke(Brand.paper, lineWidth: 2))
                        }

                    VStack(alignment: .leading, spacing: 3) {
                        Text(definition.displayName)
                            .font(.headline)
                            .foregroundStyle(Brand.ink)
                        Text(carrierHint)
                            .font(.caption)
                            .foregroundStyle(Brand.ink.opacity(0.65))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if !requiresConfirmation,
                       selectedCarrier != "auto" || parsed.carrier != .unknown {
                        carrierPickerButton
                    }
                }

                if carrierPickerVisible {
                    Divider().overlay(Brand.ink.opacity(0.12))

                    HStack(spacing: 12) {
                        Text(localizer.text("add.carrier"))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Brand.ink.opacity(0.72))
                        Spacer(minLength: 8)
                        Picker(localizer.text("add.carrier"), selection: $selectedCarrier) {
                            Text(localizer.text("add.detect")).tag("auto")
                            ForEach(catalog.selectableCarriers) { carrier in
                                let info = catalog.info(for: carrier)
                                Text(info.displayName + (catalog.tracksAutomatically(carrier)
                                    ? "" : " (\(localizer.text("add.linkOnly")))"))
                                    .tag(carrier.rawValue)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .tint(Brand.ink)
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(16)
            .addParcelCardSurface()
        }
    }

    @ViewBuilder
    private var carrierPickerButton: some View {
        if #available(iOS 26.0, *) {
            carrierPickerButtonLabel
                .buttonStyle(.glass)
        } else {
            carrierPickerButtonLabel
                .buttonStyle(.bordered)
        }
    }

    private var carrierPickerButtonLabel: some View {
        Button {
            withAnimation(.snappy) { showingCarrierPicker.toggle() }
        } label: {
            Image(systemName: carrierPickerVisible ? "checkmark" : "arrow.left.arrow.right")
                .font(.subheadline.weight(.bold))
                .frame(width: 22, height: 22)
                .contentTransition(.symbolEffect(.replace))
        }
        .foregroundStyle(Brand.ink)
        .tint(Brand.ink)
        .buttonBorderShape(.circle)
        .accessibilityLabel(carrierPickerActionTitle)
    }

    private var carrierPickerActionTitle: String {
        localizer.text(
            carrierPickerVisible
                ? selectedCarrier == "auto"
                    ? "add.useDetectedCarrier"
                    : "common.close"
                : "add.changeCarrier"
        )
    }

    private var trackingURLSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(localizer.text("add.requirement.trackingUrl"))
            VStack(alignment: .leading, spacing: 8) {
                TextField("https://…", text: $trackingURL)
                    .font(.body)
                    .foregroundStyle(Brand.ink)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .trackingURL)
                if let help = requirements.first(where: { $0.field == .trackingURL })?.help {
                    Text(help)
                        .font(.caption)
                        .foregroundStyle(Brand.ink.opacity(0.65))
                }
            }
            .padding(16)
            .addParcelCardSurface()
        }
    }

    private var dpdPostcodeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(localizer.text("add.requirement.dpdPostcode"))
            VStack(alignment: .leading, spacing: 8) {
                TextField("8004", text: $dpdPostcode)
                    .font(.title3.monospacedDigit())
                    .foregroundStyle(Brand.ink)
                    .keyboardType(.numberPad)
                    .textContentType(.postalCode)
                    .focused($focusedField, equals: .dpdPostcode)
                    .onChange(of: dpdPostcode) { _, value in
                        dpdPostcode = String(value.filter(\.isNumber).prefix(4))
                    }
                if let help = requirements.first(where: { $0.field == .dpdPostcode })?.help {
                    Text(help)
                        .font(.caption)
                        .foregroundStyle(Brand.ink.opacity(0.65))
                }
            }
            .padding(16)
            .addParcelCardSurface()
        }
    }

    private func sectionHeader(_ title: String, optional: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(Brand.ink)
            Spacer(minLength: 8)
            if optional {
                Text(localizer.text("add.optional"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Brand.ink.opacity(0.64))
            }
        }
    }

    private func validationMessage(_ text: String, symbol: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
            Text(text)
                .foregroundStyle(Brand.ink.opacity(0.74))
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Brand.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.red.opacity(0.18), lineWidth: 0.8)
        )
    }

    @ViewBuilder
    private var primaryAction: some View {
        if #available(iOS 26.0, *) {
            addButton
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.extraLarge)
                .tint(Brand.accentBright)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
        } else {
            addButton
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint(Brand.accentBright)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial)
        }
    }

    private var addButton: some View {
        Button(action: save) {
            HStack(spacing: 10) {
                if saving {
                    ProgressView()
                        .tint(Brand.onAccent)
                    Text(localizer.text("add.adding"))
                } else {
                    Image(systemName: "shippingbox.fill")
                        .symbolEffect(.bounce, value: canSave)
                    Text(localizer.text("app.addParcel"))
                }
            }
            .font(.headline)
            .foregroundStyle(Brand.onAccent)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 30)
            .contentTransition(.opacity)
        }
        .disabled(!canSave || saving)
        .accessibilityHint(localizer.text("add.intro"))
    }

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    private var parsed: TrackingInputMatch { catalog.parse(trackingInput) }

    private var resolvedCarrier: CarrierID {
        selectedCarrier == "auto"
            ? parsed.carrier
            : CarrierID(rawValue: selectedCarrier) ?? .unknown
    }

    private var resolvedDefinition: CarrierDefinition? {
        parsed.trackingNumber.isEmpty ? nil : catalog.info(for: resolvedCarrier)
    }

    private var requirements: [CarrierRequirement] {
        catalog.requirements(for: resolvedCarrier, trackingNumber: parsed.trackingNumber)
    }

    private var requiresConfirmation: Bool {
        selectedCarrier == "auto" && parsed.confidence == .low
    }

    private var carrierPickerVisible: Bool {
        showingCarrierPicker || requiresConfirmation || resolvedCarrier == .unknown
    }

    private var canSave: Bool {
        guard !parsed.trackingNumber.isEmpty, !requiresConfirmation else { return false }
        for requirement in requirements {
            switch requirement.field {
            case .trackingURL:
                let raw = parsed.trackingURL ?? trackingURL.trimmingCharacters(in: .whitespacesAndNewlines)
                guard let url = URL(string: raw), url.scheme == "https", url.host != nil else { return false }
            case .dpdPostcode:
                guard dpdPostcode.range(of: "^[0-9]{4}$", options: .regularExpression) != nil else { return false }
            }
        }
        return true
    }

    private var carrierHint: String {
        let info = catalog.info(for: resolvedCarrier)
        if requiresConfirmation {
            let names = parsed.candidates.map { catalog.info(for: $0).displayName }
                .joined(separator: " \(localizer.text("auth.or")) ")
            return localizer.text("add.confirmCarrier", ["carriers": names])
        }
        if resolvedCarrier == .unknown { return localizer.text("add.unknownCarrier") }
        return localizer.text(
            catalog.tracksAutomatically(resolvedCarrier) ? "add.autoSync" : "add.linkSync",
            ["carrier": info.displayName]
        )
    }

    private func save() {
        guard canSave, !saving else { return }
        saving = true
        errorMessage = nil
        Task {
            do {
                try await store.add(
                    trackingNumber: parsed.trackingNumber,
                    label: label,
                    carrier: resolvedCarrier,
                    trackingURL: requirements.contains(where: { $0.field == .trackingURL })
                        ? (parsed.trackingURL ?? trackingURL) : nil,
                    dpdPostcode: requirements.contains(where: { $0.field == .dpdPostcode })
                        ? dpdPostcode : nil
                )
                dismiss()
            } catch {
                errorMessage = localizer.errorMessage(error)
                saving = false
            }
        }
    }

    private func pasteTrackingInput() {
        guard let value = UIPasteboard.general.string?.trimmingCharacters(
            in: .whitespacesAndNewlines
        ), !value.isEmpty else {
            errorMessage = localizer.text("add.pasteFailed")
            return
        }
        errorMessage = nil
        trackingInput = value
    }
}

private extension View {
    func addParcelCardSurface() -> some View {
        background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Brand.paper)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Brand.separator.opacity(0.68), lineWidth: 0.8)
                )
        )
    }
}

private struct TrackingScannerView: View {
    let onScan: (String) -> Void
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TrackingDataScanner(onScan: onScan)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(localizer.text("add.scanTitle"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(localizer.text("common.cancel")) { dismiss() }
                    }
                }
        }
    }
}

private struct TrackingDataScanner: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode()],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        Task { @MainActor in try? scanner.startScanning() }
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(
        _ uiViewController: DataScannerViewController,
        coordinator: Coordinator
    ) {
        uiViewController.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onScan: (String) -> Void
        private var delivered = false

        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !delivered else { return }
            for item in addedItems {
                guard case .barcode(let barcode) = item,
                      let value = barcode.payloadStringValue?.trimmingCharacters(
                        in: .whitespacesAndNewlines
                      ), !value.isEmpty else { continue }
                delivered = true
                onScan(value)
                return
            }
        }
    }
}

struct ParcelFilterView: View {
    @Binding var status: ParcelStatusFilter
    @Binding var carrier: CarrierID?
    @Binding var sort: ParcelSort
    let carriers: [CarrierID]
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    private let catalog = CarrierCatalog.shared

    var body: some View {
        NavigationStack {
            Form {
                Section(localizer.text("view.status")) {
                    Picker(localizer.text("view.status"), selection: $status) {
                        ForEach(ParcelStatusFilter.allCases) { value in
                            Text(localizer.text(value.localizationKey)).tag(value)
                        }
                    }
                    .pickerStyle(.inline)
                }
                Section(localizer.text("view.carrier")) {
                    Picker(localizer.text("view.carrier"), selection: $carrier) {
                        Text(localizer.text("view.allCarriers")).tag(Optional<CarrierID>.none)
                        ForEach(carriers) { value in
                            Text(catalog.info(for: value).displayName).tag(Optional(value))
                        }
                    }
                }
                Section(localizer.text("view.sort")) {
                    Picker(localizer.text("view.sort"), selection: $sort) {
                        ForEach(ParcelSort.allCases) { value in
                            Text(localizer.text(value.localizationKey)).tag(value)
                        }
                    }
                    .pickerStyle(.inline)
                }
                Section {
                    Button(localizer.text("view.clear"), role: .destructive) {
                        status = .all
                        carrier = nil
                        sort = .priority
                    }
                }
            }
            .navigationTitle(localizer.text("view.showControls"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(localizer.text("native.done")) { dismiss() }.fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
