import XCTest
@testable import SwissDeliveryTracker

@MainActor
final class LocalizationTests: XCTestCase {
    func testEveryLanguageHasTheSameKeysAsEnglish() throws {
        let dictionaries = try localizationDictionaries()
        let englishKeys = Set(try XCTUnwrap(dictionaries["en"]).keys)

        XCTAssertEqual(Set(dictionaries.keys), Set(["en", "de", "fr", "it"]))
        for language in ["de", "fr", "it"] {
            XCTAssertEqual(Set(try XCTUnwrap(dictionaries[language]).keys), englishKeys, language)
        }
    }

    func testTranslationsPreserveInterpolationVariables() throws {
        let dictionaries = try localizationDictionaries()
        let english = try XCTUnwrap(dictionaries["en"])

        for language in ["de", "fr", "it"] {
            let translated = try XCTUnwrap(dictionaries[language])
            for (key, englishValue) in english {
                XCTAssertEqual(
                    variables(in: translated[key] ?? ""),
                    variables(in: englishValue),
                    "\(language).\(key)"
                )
            }
        }
    }

    func testNotificationPresetCopyExistsInEveryLanguage() throws {
        let dictionaries = try localizationDictionaries()
        let keys = NotificationPreset.allCases.flatMap { [$0.titleKey, $0.descriptionKey] }

        for (language, values) in dictionaries {
            for key in keys {
                XCTAssertFalse(values[key, default: ""].isEmpty, "\(language).\(key)")
            }
        }
    }

    func testNativeWelcomeAndErrorCopyExistsInEveryLanguage() throws {
        let dictionaries = try localizationDictionaries()
        let keys = [
            "welcome.title",
            "welcome.subtitle",
            "welcome.feature.track",
            "welcome.feature.alerts",
            "welcome.feature.private",
            "auth.subtitle",
            "auth.emailOption",
            "native.configurationHelp",
            "native.error.authenticationExpired",
            "native.auth.invalidResponse",
            "widget.galleryName",
            "widget.galleryDescription",
            "widget.settingTitle",
            "widget.settingDescription",
            "widget.disabledTitle",
            "widget.disabledDescription",
        ]

        for (language, values) in dictionaries {
            for key in keys {
                let value = values[key, default: ""]
                XCTAssertFalse(value.isEmpty, "\(language).\(key)")
                XCTAssertNotEqual(value, key, "\(language).\(key)")
            }
        }
    }

    func testKnownNativeErrorsUseTheSelectedLanguage() {
        let localizer = Localizer()
        localizer.language = .de

        XCTAssertEqual(
            localizer.errorMessage(DeliveryAPIError.authenticationExpired),
            "Deine Anmeldung ist abgelaufen. Bitte melde dich erneut an."
        )
        XCTAssertEqual(
            localizer.errorMessage(AuthenticationError.oauthCancelled),
            "Die Anmeldung wurde abgebrochen."
        )
    }

    private func localizationDictionaries() throws -> [String: [String: String]] {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "Localization", withExtension: "json"))
        return try JSONDecoder().decode([String: [String: String]].self, from: Data(contentsOf: url))
    }

    private func variables(in value: String) -> Set<String> {
        let expression = try! NSRegularExpression(pattern: "\\{\\{([A-Za-z0-9_.-]+)\\}\\}")
        let range = NSRange(value.startIndex..., in: value)
        return Set(expression.matches(in: value, range: range).compactMap { match in
            guard let range = Range(match.range(at: 1), in: value) else { return nil }
            return String(value[range])
        })
    }
}
