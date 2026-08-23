import Foundation
import SwiftUI

struct AppConfiguration: Sendable {
    enum Mode: Sendable {
        case demo
        case api
    }

    let mode: Mode
    let apiBaseURL: URL
    let supabaseURL: URL?
    let supabasePublishableKey: String
    let googleAuthEnabled: Bool
    let emailOTPEnabled: Bool
    let appGroupIdentifier: String

    static let current: AppConfiguration = {
        let useAPI = value("SDTUseAPI").uppercased() == "YES"
        let baseURL = URL(string: value("SDTAPIBaseURL"))
            ?? URL(string: "https://delivery.plhery.com")!
        let supabase = URL(string: value("SDTSupabaseURL"))
        return AppConfiguration(
            mode: useAPI ? .api : .demo,
            apiBaseURL: baseURL,
            supabaseURL: supabase,
            supabasePublishableKey: value("SDTSupabasePublishableKey"),
            googleAuthEnabled: value("SDTGoogleAuthEnabled").uppercased() == "YES",
            emailOTPEnabled: value("SDTEmailOTPEnabled").uppercased() != "NO",
            appGroupIdentifier: value("SDTAppGroupIdentifier").nonEmpty
                ?? "group.com.plhery.SwissDeliveryTracker"
        )
    }()

    var authenticationConfigured: Bool {
        supabaseURL != nil && !supabasePublishableKey.isEmpty
    }

    var privacyURL: URL {
        apiBaseURL.appending(path: "privacy.html")
    }

    private static func value(_ key: String) -> String {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return "" }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.contains("$(") ? "" : trimmed
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

enum AppLanguage: String, CaseIterable, Identifiable, Codable, Hashable {
    case en, de, fr, it

    var id: String { rawValue }
    var locale: Locale { Locale(identifier: rawValue) }
    var nativeName: String {
        switch self {
        case .en: "English"
        case .de: "Deutsch"
        case .fr: "Français"
        case .it: "Italiano"
        }
    }
}

@MainActor
final class Localizer: ObservableObject {
    @Published var language: AppLanguage {
        didSet { UserDefaults.standard.set(language.rawValue, forKey: Self.storageKey) }
    }

    private static let storageKey = "deliveryTrackerLocale"
    private let dictionaries: [String: [String: String]]

    init(bundle: Bundle = .main) {
        let saved = UserDefaults.standard.string(forKey: Self.storageKey)
        let preferred = Locale.preferredLanguages.first?.prefix(2).lowercased()
        language = AppLanguage(rawValue: saved ?? "")
            ?? AppLanguage(rawValue: String(preferred ?? ""))
            ?? .en
        if let url = bundle.url(forResource: "Localization", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode([String: [String: String]].self, from: data) {
            dictionaries = decoded
        } else {
            dictionaries = ["en": [:]]
        }
    }

    func text(_ key: String, _ variables: [String: CustomStringConvertible] = [:]) -> String {
        var result = dictionaries[language.rawValue]?[key]
            ?? dictionaries["en"]?[key]
            ?? key
        for (name, value) in variables {
            result = result.replacingOccurrences(of: "{{\(name)}}", with: value.description)
        }
        return result
    }

    func errorMessage(_ error: Error) -> String {
        if let error = error as? DeliveryAPIError {
            switch error {
            case .authenticationExpired:
                return text("native.error.authenticationExpired")
            case .duplicateTracking:
                return text("native.error.duplicateTracking")
            case .invalidResponse:
                return text("native.error.invalidResponse")
            case .labelTooLong:
                return text("native.error.labelTooLong")
            case .notificationsDenied:
                return text("native.notificationsDenied")
            case .parcelMissing:
                return text("native.parcelMissing")
            case .pushTokenUnavailable:
                return text("native.apnsTokenError")
            case .refreshFailed:
                return text("native.error.refreshFailed")
            case .refreshTimeout:
                return text("native.error.refreshTimeout")
            case .service(let message):
                return message
            case .serviceFailed(let status):
                return text("native.error.serviceFailed", ["status": status])
            }
        }
        if let error = error as? AuthenticationError {
            switch error {
            case .notConfigured:
                return text("native.auth.notConfigured")
            case .invalidResponse:
                return text("native.auth.invalidResponse")
            case .missingSession:
                return text("native.auth.missingSession")
            case .oauthCancelled:
                return text("native.auth.cancelled")
            case .requestFailed(let status):
                return text("native.auth.requestFailed", ["status": status])
            case .secureRequestFailed:
                return text("native.auth.secureRequest")
            case .sessionSaveFailed:
                return text("native.auth.saveSession")
            case .server(let message):
                return message
            }
        }
        return error.localizedDescription
    }

    func relativeTime(from value: String, now: Date = Date()) -> String {
        guard let date = DateParser.date(value) else { return "" }
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return text("time.justNow") }
        if seconds < 3_600 {
            return text("time.minutesAgo", ["count": max(1, Int(seconds / 60))])
        }
        if seconds < 86_400 {
            return text("time.hoursAgo", ["count": max(1, Int(seconds / 3_600))])
        }
        if seconds < 604_800 {
            return text("time.daysAgo", ["count": max(1, Int(seconds / 86_400))])
        }
        return shortDate(date)
    }

    func expectedDelivery(_ value: String, now: Date = Date()) -> String {
        let expression = try? NSRegularExpression(
            pattern: "^(\\d{4}-\\d{2}-\\d{2})[ T]+(\\d{2}:\\d{2})(?:[–-](\\d{2}:\\d{2}))?$"
        )
        let range = NSRange(value.startIndex..., in: value)
        if let match = expression?.firstMatch(in: value, range: range),
           let dayRange = Range(match.range(at: 1), in: value),
           let timeRange = Range(match.range(at: 2), in: value) {
            let day = expectedDelivery(String(value[dayRange]), now: now)
            var window = String(value[timeRange])
            if match.range(at: 3).location != NSNotFound,
               let endRange = Range(match.range(at: 3), in: value) {
                window += "–\(value[endRange])"
            }
            return "\(day), \(window)"
        }

        guard let date = DateParser.deliveryDate(value) else { return value }
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return text("time.today") }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(date, inSameDayAs: tomorrow) {
            return text("time.tomorrow")
        }
        return shortDate(date)
    }

    func shortDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = language.locale
        formatter.dateStyle = .short
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    func dateTime(_ value: String) -> String {
        guard let date = DateParser.date(value) else { return value }
        let formatter = DateFormatter()
        formatter.locale = language.locale
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    func parcelStatus(_ parcel: Parcel) -> String {
        text(parcel.displayStatus.key)
    }

    func parcelCompletionDate(_ parcel: Parcel) -> String? {
        if let event = parcel.currentEvent,
           event.stage.isFinal,
           let date = DateParser.date(event.occurredAt) {
            return shortDate(date)
        }
        return nil
    }
}

extension Parcel {
    var trackingSource: CarrierID? { carrierData?.activeTrackingCarrier }
    var swissPostReady: Bool { carrierData?.swissPostReady == true }
}

enum DateParser {
    private static let internetWithFraction = ISO8601DateFormatter()
    private static let internet = ISO8601DateFormatter()

    static func date(_ value: String) -> Date? {
        internetWithFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        internet.formatOptions = [.withInternetDateTime]
        return internetWithFraction.date(from: value) ?? internet.date(from: value)
    }

    static func deliveryDate(_ value: String) -> Date? {
        let day = String(value.prefix(10))
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: day)
    }

    static func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}

extension JSONDecoder {
    static var deliveryTracker: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}

extension JSONEncoder {
    static var deliveryTracker: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
