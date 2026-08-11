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

    private let catalog = CarrierCatalog.shared

    init(draft: SharedParcelDraft?) {
        self.draft = draft
        _label = State(initialValue: draft?.label ?? "")
        _trackingInput = State(initialValue: draft?.trackingInput ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(localizer.text("add.intro"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }

                Section(localizer.text("add.tracking")) {
                    TextEditor(text: $trackingInput)
                        .frame(minHeight: 86)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())

                    HStack(spacing: 10) {
                        Button(localizer.text("add.paste"), systemImage: "doc.on.clipboard") {
                            pasteTrackingInput()
                        }
                        .buttonStyle(.bordered)

                        if DataScannerViewController.isSupported,
                           DataScannerViewController.isAvailable {
                            Button(localizer.text("add.scan"), systemImage: "barcode.viewfinder") {
                                showingScanner = true
                            }
                            .buttonStyle(.bordered)
                        }
                    }

                    if !trackingInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                       parsed.trackingNumber.isEmpty {
                        Label(localizer.text("add.notFound"), systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    if !parsed.trackingNumber.isEmpty, parsed.source == .link || parsed.source == .text {
                        Label {
                            Text("\(localizer.text("add.foundPrefix")) \(CarrierCatalog.format(parsed.trackingNumber)) \(localizer.text(parsed.source == .link ? "add.foundLinkSuffix" : "add.foundTextSuffix"))")
                        } icon: {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        }
                        .font(.caption)
                    }
                }

                if let definition = resolvedDefinition, !parsed.trackingNumber.isEmpty {
                    Section(localizer.text(selectedCarrier == "auto" ? "add.detectedCarrier" : "add.carrier")) {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Color(hex: definition.color))
                                .frame(width: 10, height: 10)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(definition.displayName).font(.subheadline.weight(.semibold))
                                Text(carrierHint)
                                    .font(.caption)
                                    .foregroundStyle(requiresConfirmation ? .orange : .secondary)
                            }
                            Spacer(minLength: 4)
                            if !requiresConfirmation,
                               selectedCarrier != "auto" || parsed.carrier != .unknown {
                                Button(localizer.text(
                                    carrierPickerVisible
                                        ? selectedCarrier == "auto"
                                            ? "add.useDetectedCarrier"
                                            : "common.close"
                                        : "add.changeCarrier"
                                )) {
                                    showingCarrierPicker.toggle()
                                }
                                .font(.caption.weight(.semibold))
                            }
                        }

                        if carrierPickerVisible {
                            Picker(localizer.text("add.carrier"), selection: $selectedCarrier) {
                                Text(localizer.text("add.detect")).tag("auto")
                                ForEach(catalog.selectableCarriers) { carrier in
                                    let info = catalog.info(for: carrier)
                                    Text(info.displayName + (catalog.tracksAutomatically(carrier)
                                        ? "" : " (\(localizer.text("add.linkOnly")))"))
                                        .tag(carrier.rawValue)
                                }
                            }
                        }
                    }
                }

                if requirements.contains(where: { $0.field == .trackingURL }), parsed.trackingURL == nil {
                    Section(localizer.text("add.requirement.trackingUrl")) {
                        TextField("https://…", text: $trackingURL)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if let help = requirements.first(where: { $0.field == .trackingURL })?.help {
                            Text(help).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                if requirements.contains(where: { $0.field == .dpdPostcode }) {
                    Section(localizer.text("add.requirement.dpdPostcode")) {
                        TextField("8004", text: $dpdPostcode)
                            .keyboardType(.numberPad)
                            .textContentType(.postalCode)
                            .onChange(of: dpdPostcode) { _, value in
                                dpdPostcode = String(value.filter(\.isNumber).prefix(4))
                            }
                        if let help = requirements.first(where: { $0.field == .dpdPostcode })?.help {
                            Text(help).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                Section(localizer.text("add.contents")) {
                    TextField(localizer.text("add.contentsPlaceholder"), text: $label)
                        .textContentType(.name)
                        .onChange(of: label) { _, value in
                            if value.count > 80 { label = String(value.prefix(80)) }
                        }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(.red)
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(localizer.text("add.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localizer.text("common.cancel")) { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        save()
                    } label: {
                        if saving { ProgressView() }
                        else { Text(localizer.text("app.addParcel")) }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSave || saving)
                }
            }
            .interactiveDismissDisabled(saving)
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
                    trackingInput = value
                    showingScanner = false
                }
                .environmentObject(localizer)
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
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
                errorMessage = error.localizedDescription
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
