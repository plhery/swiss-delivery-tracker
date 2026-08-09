import Foundation
import UniformTypeIdentifiers

struct SharedParcelDraft: Codable, Identifiable, Equatable {
    let id: UUID
    let label: String
    let trackingInput: String

    init(id: UUID = UUID(), label: String = "", trackingInput: String) {
        self.id = id
        self.label = label
        self.trackingInput = trackingInput
    }
}

enum ShareInbox {
    private static let key = "sdt.sharedParcelDraft"

    static func consume(configuration: AppConfiguration = .current) -> SharedParcelDraft? {
        guard let defaults = UserDefaults(suiteName: configuration.appGroupIdentifier),
              let data = defaults.data(forKey: key),
              let draft = try? JSONDecoder().decode(SharedParcelDraft.self, from: data) else {
            return nil
        }
        defaults.removeObject(forKey: key)
        return draft
    }
}
