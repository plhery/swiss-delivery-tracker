import Foundation

struct CarrierRequirement: Codable, Hashable, Sendable {
    enum Field: String, Codable, Sendable {
        case trackingURL = "trackingUrl"
        case dpdPostcode
    }

    let field: Field
    let validator: String?
    let whenTrackingNumber: String?
    let label: String
    let type: String
    let placeholder: String?
    let help: String?
    let pattern: String?
    let maxLength: Int?
    let inputMode: String?
    let autoComplete: String?

    func normalizedValue(_ rawValue: String) -> String {
        var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if inputMode == "numeric" {
            value = value.filter(\.isNumber)
        }
        if let maxLength {
            value = String(value.prefix(maxLength))
        }
        return value
    }

    func accepts(_ rawValue: String) -> Bool {
        var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if inputMode == "numeric" {
            value = value.filter(\.isNumber)
        }
        guard !value.isEmpty else { return false }
        if let maxLength, value.count > maxLength { return false }
        guard let pattern, !pattern.isEmpty else { return true }
        return value.range(of: pattern, options: .regularExpression) != nil
    }
}

struct CarrierDefinition: Codable, Sendable {
    struct Tracking: Codable, Sendable {
        let mode: String
        let adapter: String?
        let requirements: [CarrierRequirement]?
    }

    struct LinkRule: Codable, Sendable {
        let domains: [String]
        let params: [String]?
        let path: String?
        let keepsCapabilityURL: Bool?

        enum CodingKeys: String, CodingKey {
            case domains, params, path
            case keepsCapabilityURL = "keepsCapabilityUrl"
        }
    }

    struct DetectionRule: Codable, Sendable {
        let pattern: String
        let confidence: String
        let checksum: String?
    }

    let displayName: String
    let color: String
    let selectable: Bool
    let timezone: String
    let tracking: Tracking
    let trackingURLTemplate: String?
    let linkRules: [LinkRule]
    let detectionRules: [DetectionRule]

    enum CodingKeys: String, CodingKey {
        case displayName, color, selectable, timezone, tracking, linkRules, detectionRules
        case trackingURLTemplate = "trackingUrlTemplate"
    }
}

struct CarrierMatch: Equatable, Sendable {
    enum Confidence: String, Sendable {
        case high, low, none
    }

    let carrier: CarrierID
    let confidence: Confidence
    let candidates: [CarrierID]
}

struct TrackingInputMatch: Equatable, Sendable {
    enum Source: String, Sendable {
        case number, link, text, none
    }

    let trackingNumber: String
    let carrier: CarrierID
    let confidence: CarrierMatch.Confidence
    let candidates: [CarrierID]
    let trackingURL: String?
    let source: Source
}

struct ParcelTrackingLink: Identifiable, Sendable {
    enum Role: Sendable { case active, waiting, history }
    let carrier: CarrierID
    let name: String
    let url: URL
    let role: Role
    var id: CarrierID { carrier }
}

final class CarrierCatalog: @unchecked Sendable {
    private struct Contract: Decodable {
        let carriers: [String: CarrierDefinition]
        enum CodingKeys: String, CodingKey { case carriers = "x-carriers" }
    }

    static let shared = CarrierCatalog()
    private(set) var definitions: [CarrierID: CarrierDefinition]

    init(bundle: Bundle = .main) {
        guard let url = bundle.url(forResource: "CarrierCatalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let contract = try? JSONDecoder().decode(Contract.self, from: data) else {
            definitions = Self.fallbackDefinitions
            return
        }
        definitions = Dictionary(uniqueKeysWithValues: contract.carriers.compactMap { key, value in
            CarrierID(rawValue: key).map { ($0, value) }
        })
    }

    init(data: Data) throws {
        let contract = try JSONDecoder().decode(Contract.self, from: data)
        definitions = Dictionary(uniqueKeysWithValues: contract.carriers.compactMap { key, value in
            CarrierID(rawValue: key).map { ($0, value) }
        })
    }

    func info(for carrier: CarrierID) -> CarrierDefinition {
        definitions[carrier] ?? definitions[.unknown] ?? Self.fallbackDefinitions[.unknown]!
    }

    var selectableCarriers: [CarrierID] {
        definitions.compactMap { $0.value.selectable ? $0.key : nil }
            .sorted { info(for: $0).displayName.localizedCaseInsensitiveCompare(
                info(for: $1).displayName
            ) == .orderedAscending }
    }

    func tracksAutomatically(_ carrier: CarrierID) -> Bool {
        info(for: carrier).tracking.mode == "automatic"
    }

    func requirements(for carrier: CarrierID, trackingNumber: String) -> [CarrierRequirement] {
        let normalized = Self.normalize(trackingNumber)
        return (info(for: carrier).tracking.requirements ?? []).filter { requirement in
            guard let pattern = requirement.whenTrackingNumber else { return true }
            return Self.matches(normalized, pattern: pattern)
        }
    }

    func detect(_ raw: String) -> CarrierMatch {
        let number = Self.normalize(raw)
        guard !number.isEmpty else {
            return CarrierMatch(carrier: .unknown, confidence: .none, candidates: [])
        }
        var matches: [(CarrierID, CarrierMatch.Confidence)] = []
        for (carrier, definition) in definitions {
            for rule in definition.detectionRules {
                guard Self.matches(number, pattern: rule.pattern) else { continue }
                if rule.checksum == "s10" && !Self.isValidS10(number) { continue }
                matches.append((carrier, rule.confidence == "high" ? .high : .low))
                break
            }
        }
        let high = matches.filter { $0.1 == .high }
        let ranked = high.isEmpty ? matches : high
        let candidates = ranked.map(\.0).sorted { $0.rawValue < $1.rawValue }
        if high.count == 1 {
            return CarrierMatch(carrier: high[0].0, confidence: .high, candidates: candidates)
        }
        return CarrierMatch(
            carrier: .unknown,
            confidence: matches.isEmpty ? .none : .low,
            candidates: candidates
        )
    }

    func parse(_ raw: String) -> TrackingInputMatch {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return Self.emptyMatch }

        for pasted in Self.matches(in: input, pattern: "https?://[^\\s<>\\\"']+") {
            let cleaned = pasted
                .trimmingCharacters(
                    in: CharacterSet.whitespacesAndNewlines
                        .union(CharacterSet(charactersIn: "<>'\"()[],;.!?"))
                )
            guard let components = URLComponents(string: cleaned),
                  let host = components.host?.lowercased() else { continue }
            var matchingRules: [(carrier: CarrierID, rule: CarrierDefinition.LinkRule)] = []
            for (carrier, definition) in definitions {
                for rule in definition.linkRules where rule.domains.contains(where: {
                    host == $0 || host.hasSuffix(".\($0)")
                }) {
                    matchingRules.append((carrier, rule))
                }
            }
            matchingRules.sort { $0.carrier.rawValue < $1.carrier.rawValue }
            for firstMatch in matchingRules {
                let queryValue = components.queryItems?.first { item in
                    firstMatch.rule.params?.contains {
                        $0.caseInsensitiveCompare(item.name) == .orderedSame
                    } == true
                }?.value
                var pathValue: String?
                if let path = firstMatch.rule.path {
                    pathValue = Self.capture(components.path, pattern: path)
                }
                let candidate = (queryValue ?? pathValue ?? "")
                    .split(whereSeparator: { $0 == "," || $0 == "|" }).first.map(String.init) ?? ""
                if Self.valid(candidate) {
                    let detected = detect(candidate)
                    let selected = detected.confidence == .high
                        ? matchingRules.first(where: { $0.carrier == detected.carrier }) ?? firstMatch
                        : firstMatch
                    return TrackingInputMatch(
                        trackingNumber: candidate,
                        carrier: selected.carrier,
                        confidence: .high,
                        candidates: [selected.carrier],
                        trackingURL: selected.rule.keepsCapabilityURL == true ? cleaned : nil,
                        source: .link
                    )
                }
            }
            let decoded = cleaned.removingPercentEncoding ?? cleaned
            if let recognized = recognizedNumber(in: decoded) {
                return makeMatch(recognized, source: .link)
            }
        }

        if let recognized = recognizedNumber(in: input) {
            return makeMatch(recognized, source: input == recognized ? .number : .text)
        }

        let keywordPattern = "(?:(?:tracking|track(?:ing)?\\s*(?:number|no\\.?|id)?)|(?:parcel|shipment)(?:\\s+(?:tracking|number|no\\.?|id))?)\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9.-]{3,39})"
        if let keyword = Self.capture(input, pattern: keywordPattern, caseInsensitive: true), Self.valid(keyword) {
            return makeMatch(keyword, source: .text)
        }
        if !input.contains("://"), Self.valid(input) { return makeMatch(input, source: .number) }
        return Self.emptyMatch
    }

    func trackingLinks(for parcel: Parcel, language: AppLanguage) -> [ParcelTrackingLink] {
        if !Self.supportsSwissPostHandoff(parcel.trackingNumber) {
            let definition = info(for: parcel.carrier)
            guard let raw = parcel.trackingURL
                    ?? definition.trackingURLTemplate?.replacingOccurrences(
                        of: "{trackingNumber}", with: Self.urlEncode(parcel.trackingNumber)
                    ),
                  let url = localizedURL(raw, carrier: parcel.carrier, language: language) else { return [] }
            return [ParcelTrackingLink(
                carrier: parcel.carrier,
                name: definition.displayName,
                url: url,
                role: .active
            )]
        }

        let active = parcel.activeTrackingCarrier
        let ready = parcel.swissPostReady || active == .swissPost
        return [CarrierID.aliexpress, .swissPost].compactMap { carrier in
            let definition = info(for: carrier)
            guard let template = definition.trackingURLTemplate,
                  let url = localizedURL(
                    template.replacingOccurrences(
                        of: "{trackingNumber}", with: Self.urlEncode(parcel.trackingNumber)
                    ),
                    carrier: carrier,
                    language: language
                  ) else { return nil }
            let role: ParcelTrackingLink.Role = carrier == active
                ? .active
                : (carrier == .swissPost && !ready ? .waiting : .history)
            return ParcelTrackingLink(carrier: carrier, name: definition.displayName, url: url, role: role)
        }.sorted { left, _ in left.role == .active }
    }

    private func recognizedNumber(in text: String) -> String? {
        let patterns = [
            "\\b1Z[A-Z0-9]{16}\\b",
            "\\b1G[A-Z0-9]{10}\\b",
            "\\b[A-Z]{2}\\s*\\d(?:[\\s.-]?\\d){8}\\s*[A-Z]{2}\\b",
            "\\b(?:JJD|JVGL)[A-Z0-9]{8,}\\b",
            "\\b\\d(?:[\\s.-]?\\d){9,19}\\b",
        ]
        for pattern in patterns {
            for candidate in Self.matches(in: text, pattern: pattern, caseInsensitive: true) {
                if detect(candidate).confidence == .high { return candidate.trimmingCharacters(in: .whitespaces) }
            }
        }
        return nil
    }

    private func makeMatch(_ number: String, source: TrackingInputMatch.Source) -> TrackingInputMatch {
        let result = detect(number)
        return TrackingInputMatch(
            trackingNumber: number,
            carrier: result.carrier,
            confidence: result.confidence,
            candidates: result.candidates,
            trackingURL: nil,
            source: source
        )
    }

    private func localizedURL(_ raw: String, carrier: CarrierID, language: AppLanguage) -> URL? {
        guard carrier == .swissPost, var components = URLComponents(string: raw) else {
            return URL(string: raw)
        }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "lang" }
        items.append(URLQueryItem(name: "lang", value: language.rawValue))
        components.queryItems = items
        return components.url
    }

    static func normalize(_ raw: String) -> String {
        raw.uppercased().replacingOccurrences(of: "[\\s.-]", with: "", options: .regularExpression)
    }

    static func format(_ raw: String) -> String {
        let value = normalize(raw)
        if matches(value, pattern: "^99990\\d{8}$") {
            return "\(value.prefix(3)).\(value.dropFirst(3).prefix(2)).\(value.dropFirst(5))"
        }
        if matches(value, pattern: "^\\d{18}$") {
            return "\(value.prefix(2)).\(value.dropFirst(2).prefix(2)).\(value.dropFirst(4).prefix(6)).\(value.dropFirst(10))"
        }
        return value
    }

    static func isValidS10(_ raw: String) -> Bool {
        let value = normalize(raw)
        guard matches(value, pattern: "^[A-Z]{2}\\d{9}[A-Z]{2}$") else { return false }
        let characters = Array(value)
        let weights = [8, 6, 4, 2, 3, 5, 9, 7]
        let sum = weights.enumerated().reduce(0) { partial, item in
            partial + (characters[item.offset + 2].wholeNumberValue ?? 0) * item.element
        }
        let rawCheck = 11 - sum % 11
        let expected = rawCheck == 10 ? 0 : (rawCheck == 11 ? 5 : rawCheck)
        return characters[10].wholeNumberValue == expected
    }

    static func supportsSwissPostHandoff(_ raw: String) -> Bool {
        let value = normalize(raw)
        return matches(value, pattern: "^L[A-Z]\\d{9}CH$") && isValidS10(value)
    }

    private static func valid(_ raw: String) -> Bool {
        let value = normalize(raw)
        return (4...40).contains(value.count)
            && matches(value, pattern: "^[A-Z0-9]+$")
            && matches(value, pattern: "\\d")
    }

    private static func matches(_ value: String, pattern: String) -> Bool {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return false }
        return expression.firstMatch(
            in: value,
            range: NSRange(value.startIndex..., in: value)
        ) != nil
    }

    private static func matches(
        in value: String,
        pattern: String,
        caseInsensitive: Bool = false
    ) -> [String] {
        let options: NSRegularExpression.Options = caseInsensitive ? .caseInsensitive : []
        guard let expression = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
        return expression.matches(in: value, range: NSRange(value.startIndex..., in: value)).compactMap {
            Range($0.range, in: value).map { String(value[$0]) }
        }
    }

    private static func capture(
        _ value: String,
        pattern: String,
        caseInsensitive: Bool = false
    ) -> String? {
        let options: NSRegularExpression.Options = caseInsensitive ? .caseInsensitive : []
        guard let expression = try? NSRegularExpression(pattern: pattern, options: options),
              let match = expression.firstMatch(
                in: value,
                range: NSRange(value.startIndex..., in: value)
              ),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: value) else { return nil }
        return String(value[range])
    }

    private static func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    private static let emptyMatch = TrackingInputMatch(
        trackingNumber: "",
        carrier: .unknown,
        confidence: .none,
        candidates: [],
        trackingURL: nil,
        source: .none
    )

    private static let fallbackDefinitions: [CarrierID: CarrierDefinition] = [
        .unknown: CarrierDefinition(
            displayName: "Carrier",
            color: "#8e8e93",
            selectable: false,
            timezone: "UTC",
            tracking: .init(mode: "link-only", adapter: nil, requirements: nil),
            trackingURLTemplate: nil,
            linkRules: [],
            detectionRules: []
        ),
    ]
}
