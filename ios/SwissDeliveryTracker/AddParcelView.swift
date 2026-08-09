import SwiftUI

struct AddParcelView: View {
    let draft: SharedParcelDraft?
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @State private var label: String
    @State private var trackingInput: String
    @State private var selectedCarrier = "auto"
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

                Section(localizer.text("add.contents")) {
                    TextField(localizer.text("add.contentsPlaceholder"), text: $label)
                        .textContentType(.name)
                        .onChange(of: label) { _, value in
                            if value.count > 80 { label = String(value.prefix(80)) }
                        }
                }

                Section(localizer.text("add.tracking")) {
                    TextEditor(text: $trackingInput)
                        .frame(minHeight: 86)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())

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

                Section(localizer.text("add.carrier")) {
                    Picker(localizer.text("add.carrier"), selection: $selectedCarrier) {
                        Text(localizer.text("add.detect")).tag("auto")
                        ForEach(catalog.selectableCarriers) { carrier in
                            let info = catalog.info(for: carrier)
                            Text(info.displayName + (catalog.tracksAutomatically(carrier)
                                ? "" : " (\(localizer.text("add.linkOnly")))"))
                                .tag(carrier.rawValue)
                        }
                    }

                    if let definition = resolvedDefinition, !parsed.trackingNumber.isEmpty {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Color(hex: definition.color))
                                .frame(width: 10, height: 10)
                            Text(carrierHint)
                                .font(.caption)
                                .foregroundStyle(requiresConfirmation ? .orange : .secondary)
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
