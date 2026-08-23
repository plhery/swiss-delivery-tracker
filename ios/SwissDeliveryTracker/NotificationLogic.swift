import Foundation
import UserNotifications

enum NotificationPreset: String, CaseIterable, Identifiable {
    case all, important, deliveryDay

    var id: String { rawValue }

    var stages: [NotificationStage] {
        switch self {
        case .all:
            [.registered, .accepted, .inTransit, .customs, .outForDelivery,
             .failedAttempt, .readyForPickup, .delivered, .returned]
        case .important:
            [.customs, .outForDelivery, .failedAttempt, .readyForPickup, .delivered, .returned]
        case .deliveryDay:
            [.outForDelivery, .delivered]
        }
    }

    var titleKey: String {
        switch self {
        case .all: "notifications.preset.all"
        case .important: "notifications.preset.important"
        case .deliveryDay: "notifications.preset.deliveryDay"
        }
    }

    var descriptionKey: String { "\(titleKey)Description" }

    static func matching(_ stages: [NotificationStage]) -> NotificationPreset {
        let enabled = Set(stages)
        return allCases.first { Set($0.stages) == enabled } ?? .all
    }
}

struct NotificationPreferencesDraft: Equatable {
    private static let defaultQuietStart = "22:00"
    private static let defaultQuietEnd = "08:00"

    var preset: NotificationPreset
    var quietHoursEnabled: Bool
    var quietStart: Date
    var quietEnd: Date

    init(preferences: NotificationPreferences? = nil, calendar: Calendar = .current) {
        preset = preferences.map { NotificationPreset.matching($0.enabledStages) } ?? .all
        quietHoursEnabled = preferences?.quietHoursStart != nil && preferences?.quietHoursEnd != nil
        quietStart = Self.date(
            from: preferences?.quietHoursStart ?? Self.defaultQuietStart,
            calendar: calendar
        )
        quietEnd = Self.date(
            from: preferences?.quietHoursEnd ?? Self.defaultQuietEnd,
            calendar: calendar
        )
    }

    func preferences(timezone: String, calendar: Calendar = .current) -> NotificationPreferences {
        NotificationPreferences(
            enabledStages: preset.stages,
            quietHoursStart: quietHoursEnabled ? Self.string(from: quietStart, calendar: calendar) : nil,
            quietHoursEnd: quietHoursEnabled ? Self.string(from: quietEnd, calendar: calendar) : nil,
            timezone: timezone
        )
    }

    private static func date(from value: String, calendar: Calendar) -> Date {
        formatter(calendar: calendar).date(from: value)
            ?? formatter(calendar: calendar).date(from: defaultQuietStart)
            ?? Date(timeIntervalSince1970: 0)
    }

    private static func string(from date: Date, calendar: Calendar) -> String {
        formatter(calendar: calendar).string(from: date)
    }

    private static func formatter(calendar: Calendar) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "HH:mm"
        return formatter
    }
}

enum NotificationDevicePolicy {
    static func isAuthorized(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional
    }

    static func isEnabled(
        isDemo: Bool,
        status: UNAuthorizationStatus,
        optedOut: Bool,
        nativePushRegistered: Bool,
        demoNotificationsEnabled: Bool
    ) -> Bool {
        if isDemo { return demoNotificationsEnabled }
        return isAuthorized(status) && !optedOut && nativePushRegistered
    }

    static func shouldRegisterForRemoteNotifications(
        status: UNAuthorizationStatus,
        optedOut: Bool
    ) -> Bool {
        isAuthorized(status) && !optedOut
    }
}

enum NotificationOnboardingPolicy {
    static func shouldPresent(
        isAuthenticated: Bool,
        isDemo: Bool,
        completed: Bool
    ) -> Bool {
        isAuthenticated && !isDemo && !completed
    }
}
