import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let statusLabel = UILabel()
    private let openButton = UIButton(type: .system)
    private var parcelLabel = ""
    private var trackingInput = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.969, green: 0.953, blue: 0.918, alpha: 1)
        configureInterface()
        loadSharedContent()
    }

    private func configureInterface() {
        let mark = UIImageView(image: UIImage(systemName: "shippingbox.fill"))
        mark.preferredSymbolConfiguration = .init(pointSize: 34, weight: .semibold)
        mark.tintColor = UIColor(red: 0.09, green: 0.09, blue: 0.08, alpha: 1)
        mark.backgroundColor = UIColor(red: 1, green: 0.84, blue: 0.04, alpha: 1)
        mark.layer.cornerRadius = 22
        mark.contentMode = .center
        mark.translatesAutoresizingMaskIntoConstraints = false

        let title = UILabel()
        title.text = ShareCopy.text("title")
        title.font = .preferredFont(forTextStyle: .title2).withWeight(.bold)
        title.textAlignment = .center

        statusLabel.text = ShareCopy.text("reading")
        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center

        var openConfiguration = UIButton.Configuration.filled()
        openConfiguration.title = ShareCopy.text("open")
        openConfiguration.image = UIImage(systemName: "arrow.up.forward.app")
        openConfiguration.imagePadding = 8
        openConfiguration.cornerStyle = .large
        openConfiguration.baseBackgroundColor = UIColor(red: 1, green: 0.81, blue: 0, alpha: 1)
        openConfiguration.baseForegroundColor = UIColor(red: 0.09, green: 0.09, blue: 0.08, alpha: 1)
        openButton.configuration = openConfiguration
        openButton.isEnabled = false
        openButton.addTarget(self, action: #selector(openApp), for: .touchUpInside)

        let cancel = UIButton(type: .system)
        cancel.setTitle(ShareCopy.text("cancel"), for: .normal)
        cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [mark, title, statusLabel, openButton, cancel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 18
        stack.setCustomSpacing(26, after: statusLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 76),
            mark.heightAnchor.constraint(equalToConstant: 76),
            openButton.widthAnchor.constraint(equalTo: stack.widthAnchor),
            openButton.heightAnchor.constraint(equalToConstant: 52),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor, constant: -8),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func loadSharedContent() {
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        parcelLabel = items.compactMap { $0.attributedTitle?.string.trimmed.nonEmpty }
            .first.map { String($0.prefix(80)) } ?? ""
        let itemText = items.compactMap { $0.attributedContentText?.string.trimmed.nonEmpty }
        let candidates = providers.compactMap { provider -> (NSItemProvider, String)? in
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                return (provider, UTType.url.identifier)
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                return (provider, UTType.plainText.identifier)
            }
            return nil
        }
        guard !candidates.isEmpty || !itemText.isEmpty else {
            statusLabel.text = ShareCopy.text("notFound")
            return
        }

        var loaded = Array<String?>(repeating: nil, count: candidates.count)
        var lastError: Error?
        let group = DispatchGroup()
        for (index, candidate) in candidates.enumerated() {
            group.enter()
            candidate.0.loadItem(forTypeIdentifier: candidate.1) { value, error in
                let text: String?
                if let url = value as? URL { text = url.absoluteString }
                else if let textValue = value as? String { text = textValue }
                else if let data = value as? Data { text = String(data: data, encoding: .utf8) }
                else { text = nil }
                DispatchQueue.main.async {
                    loaded[index] = text?.trimmed.nonEmpty
                    if let error { lastError = error }
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            let parts = (loaded.compactMap { $0 } + itemText).reduce(into: [String]()) { result, value in
                if !result.contains(value) { result.append(value) }
            }
            self.trackingInput = String(parts.joined(separator: "\n").prefix(10_000))
            if self.trackingInput.isEmpty {
                self.statusLabel.text = lastError?.localizedDescription ?? ShareCopy.text("notFound")
            } else {
                self.saveDraft()
                self.statusLabel.text = ShareCopy.text("ready")
                self.openButton.isEnabled = true
            }
        }
    }

    private func saveDraft() {
        let group = Bundle.main.object(forInfoDictionaryKey: "SDTAppGroupIdentifier") as? String
            ?? "group.com.plhery.SwissDeliveryTracker"
        let value: [String: String] = [
            "id": UUID().uuidString,
            "label": parcelLabel,
            "trackingInput": trackingInput,
        ]
        guard let data = try? JSONEncoder().encode(value) else { return }
        UserDefaults(suiteName: group)?.set(data, forKey: "sdt.sharedParcelDraft")
    }

    @objc private func openApp() {
        guard let url = URL(string: "swissdeliverytracker://add") else { return }
        extensionContext?.open(url) { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    @objc private func cancelShare() {
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
}

private enum ShareCopy {
    private static let catalogs: [String: [String: String]] = [
        "en": [
            "title": "Add to Delivery Tracker",
            "reading": "Reading the shared tracking information…",
            "open": "Open Delivery Tracker",
            "cancel": "Cancel",
            "notFound": "No tracking number, text, or link was found.",
            "ready": "Ready. The app will detect the carrier and tracking number for you.",
        ],
        "de": [
            "title": "Zu Delivery Tracker hinzufügen",
            "reading": "Geteilte Sendungsinformationen werden gelesen…",
            "open": "Delivery Tracker öffnen",
            "cancel": "Abbrechen",
            "notFound": "Keine Sendungsnummer, kein Text und kein Link gefunden.",
            "ready": "Bereit. Die App erkennt den Anbieter und die Sendungsnummer automatisch.",
        ],
        "fr": [
            "title": "Ajouter à Delivery Tracker",
            "reading": "Lecture des informations de suivi partagées…",
            "open": "Ouvrir Delivery Tracker",
            "cancel": "Annuler",
            "notFound": "Aucun numéro de suivi, texte ou lien n’a été trouvé.",
            "ready": "Prêt. L’app détectera automatiquement le transporteur et le numéro de suivi.",
        ],
        "it": [
            "title": "Aggiungi a Delivery Tracker",
            "reading": "Lettura delle informazioni di tracciamento condivise…",
            "open": "Apri Delivery Tracker",
            "cancel": "Annulla",
            "notFound": "Non è stato trovato alcun numero di tracciamento, testo o link.",
            "ready": "Pronto. L’app rileverà automaticamente il corriere e il numero di tracciamento.",
        ],
    ]

    static func text(_ key: String) -> String {
        let language = Locale.preferredLanguages.first?
            .split(separator: "-").first.map(String.init) ?? "en"
        return catalogs[language]?[key] ?? catalogs["en"]?[key] ?? key
    }
}

private extension UIFont {
    func withWeight(_ weight: UIFont.Weight) -> UIFont {
        let descriptor = fontDescriptor.addingAttributes([
            .traits: [UIFontDescriptor.TraitKey.weight: weight],
        ])
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var nonEmpty: String? { isEmpty ? nil : self }
}
