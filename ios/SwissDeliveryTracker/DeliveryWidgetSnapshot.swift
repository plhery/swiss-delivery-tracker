import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

struct DeliveryWidgetParcel: Codable, Equatable, Hashable, Identifiable, Sendable {
    let id: UUID
    let label: String
    let carrier: String
    let trackingNumber: String
    let detail: String
    let isOutForDelivery: Bool

    var deepLink: URL {
        URL(string: "swissdeliverytracker://parcel/\(id.uuidString)")!
    }
}

struct DeliveryWidgetSnapshot: Codable, Equatable, Sendable {
    let generatedAt: Date
    let languageCode: String
    let parcels: [DeliveryWidgetParcel]
}

#if canImport(ActivityKit)
enum DeliveryActivityPhase: String, Codable, Hashable, Sendable {
    case outForDelivery = "out_for_delivery"
    case delivered
    case failedAttempt = "failed_attempt"
    case readyForPickup = "ready_for_pickup"
    case returned
    case ended
}

struct DeliveryActivityParcel: Codable, Equatable, Hashable, Identifiable, Sendable {
    let id: UUID
    let label: String
    let carrier: String
    let status: String
    let detail: String
    let phase: DeliveryActivityPhase

    var deepLink: URL {
        URL(string: "swissdeliverytracker://parcel/\(id.uuidString)")!
    }
}

struct DeliveryActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let parcel: DeliveryActivityParcel
        let languageCode: String
    }

    let parcelID: UUID
}
#endif

enum DeliveryWidgetSelection {
    static func displayParcels(
        from priorityOrderedCandidates: [DeliveryWidgetParcel],
        limit: Int = 2
    ) -> [DeliveryWidgetParcel] {
        guard limit > 0 else { return [] }
        let outForDelivery = priorityOrderedCandidates.filter(\.isOutForDelivery)
        if outForDelivery.count >= limit {
            return Array(outForDelivery.prefix(limit))
        }
        guard let firstOutForDelivery = outForDelivery.first else {
            return Array(priorityOrderedCandidates.prefix(1))
        }
        guard limit > 1,
              let nextUp = priorityOrderedCandidates.first(where: { !$0.isOutForDelivery }) else {
            return [firstOutForDelivery]
        }
        return [firstOutForDelivery, nextUp]
    }
}

struct DeliveryWidgetSharedStore {
    static let kind = "NextDeliveryWidget"
    static let defaultAppGroupIdentifier = "group.com.plhery.SwissDeliveryTracker"

    private static let enabledKey = "sdt.deliveryWidget.enabled.v1"
    private static let liveActivitiesEnabledKey = "sdt.deliveryLiveActivities.enabled.v1"
    private static let languageKey = "sdt.deliveryWidget.language.v1"
    private static let snapshotKey = "sdt.deliveryWidget.snapshot.v1"
    private let defaults: UserDefaults

    init?(appGroupIdentifier: String, fallbackToStandard: Bool = false) {
        if FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) != nil,
           let defaults = UserDefaults(suiteName: appGroupIdentifier) {
            self.defaults = defaults
        } else if fallbackToStandard {
            // Personal Team builds cannot carry App Group entitlements. Keeping the
            // preference local still lets their Live Activity opt-out work.
            defaults = .standard
        } else {
            return nil
        }
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    var isEnabled: Bool {
        defaults.object(forKey: Self.enabledKey) == nil
            || defaults.bool(forKey: Self.enabledKey)
    }

    var languageCode: String? {
        defaults.string(forKey: Self.languageKey)
    }

    var liveActivitiesEnabled: Bool {
        defaults.object(forKey: Self.liveActivitiesEnabledKey) == nil
            ? isEnabled
            : defaults.bool(forKey: Self.liveActivitiesEnabledKey)
    }

    var snapshot: DeliveryWidgetSnapshot? {
        guard let data = defaults.data(forKey: Self.snapshotKey) else { return nil }
        return try? JSONDecoder().decode(DeliveryWidgetSnapshot.self, from: data)
    }

    func setEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: Self.enabledKey)
        if !enabled { clearSnapshot() }
    }

    func setLiveActivitiesEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: Self.liveActivitiesEnabledKey)
    }

    func setLanguageCode(_ languageCode: String) {
        defaults.set(languageCode, forKey: Self.languageKey)
    }

    @discardableResult
    func save(_ snapshot: DeliveryWidgetSnapshot) -> Bool {
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        defaults.set(data, forKey: Self.snapshotKey)
        return true
    }

    func clearSnapshot() {
        defaults.removeObject(forKey: Self.snapshotKey)
    }

    static func appGroupIdentifier(bundle: Bundle = .main) -> String {
        let configured = bundle.object(forInfoDictionaryKey: "SDTAppGroupIdentifier") as? String
        guard let configured,
              !configured.isEmpty,
              !configured.contains("$(") else {
            return defaultAppGroupIdentifier
        }
        return configured
    }
}
