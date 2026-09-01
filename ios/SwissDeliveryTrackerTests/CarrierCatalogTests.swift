import XCTest
@testable import SwissDeliveryTracker

final class CarrierCatalogTests: XCTestCase {
    private let catalog = CarrierCatalog.shared

    func testDetectsHighConfidenceCarriers() {
        XCTAssertEqual(catalog.detect("1Z999AA10123456784").carrier, .ups)
        XCTAssertEqual(catalog.detect("443412345678901234").carrier, .quickpac)
        XCTAssertEqual(catalog.detect("RA123456785CH").carrier, .swissPost)
        XCTAssertEqual(catalog.detect("250123456789012").carrier, .dpdFr)
        XCTAssertEqual(catalog.detect("CC200000000401").carrier, .relaisColis)
        XCTAssertEqual(catalog.detect("FGRC45BKLM").carrier, .cChezVous)
        XCTAssertEqual(catalog.detect("ASE12345678").carrier, .asendia)
        XCTAssertEqual(catalog.detect("FR1234567890").carrier, .amazonLogistics)
    }

    func testKeepsAmbiguousCarrierForConfirmation() {
        let result = catalog.detect("12345678901234")
        XCTAssertEqual(result.carrier, .unknown)
        XCTAssertEqual(result.confidence, .low)
        XCTAssertTrue(result.candidates.contains(.dpd))

        for value in ["AB12CD34", "36631000001", "99112233445575012"] {
            let frenchResult = catalog.detect(value)
            XCTAssertEqual(frenchResult.carrier, .unknown)
            XCTAssertEqual(frenchResult.confidence, .low)
        }
        XCTAssertEqual(catalog.detect("99112233445500000").confidence, .none)
    }

    func testParsesKnownCarrierLink() {
        let parsed = catalog.parse("Track it: https://www.ups.com/track?tracknum=1Z999AA10123456784")
        XCTAssertEqual(parsed.trackingNumber, "1Z999AA10123456784")
        XCTAssertEqual(parsed.carrier, .ups)
        XCTAssertEqual(parsed.source, .link)
    }

    func testParsesGeodisHashLinkAndExposesFrenchCarriersInThePicker() {
        let parsed = catalog.parse(
            "https://espace-client.geodis.com/services/destinataires/#/fr/suivi/1G123GEODIS0"
        )
        XCTAssertEqual(parsed.trackingNumber, "1G123GEODIS0")
        XCTAssertEqual(parsed.carrier, .geodis)
        XCTAssertEqual(parsed.source, .link)
        for carrier in [
            CarrierID.dpdFr, .mondialRelay, .relaisColis,
            .laPoste, .chronopost, .glsFr, .colisPrive, .geodis,
            .swissPostCargo, .glsCh, .colisweb, .cChezVous,
            .heppner, .ciblex, .paack,
            .amazonLogistics,
        ] {
            XCTAssertTrue(catalog.selectableCarriers.contains(carrier), carrier.rawValue)
            XCTAssertTrue(catalog.tracksAutomatically(carrier), carrier.rawValue)
        }
        XCTAssertTrue(catalog.selectableCarriers.contains(.asendia))
        XCTAssertFalse(catalog.tracksAutomatically(.asendia))
    }

    func testCountrySpecificPostcodeRequirementsNormalizeAndValidate() throws {
        let dpd = try XCTUnwrap(
            catalog.requirements(for: .dpd, trackingNumber: "12345678901234")
                .first(where: { $0.field == .dpdPostcode })
        )
        XCTAssertEqual(dpd.placeholder, "8004")
        XCTAssertEqual(dpd.maxLength, 4)
        XCTAssertEqual(dpd.normalizedValue("80 A04 9"), "8004")
        XCTAssertTrue(dpd.accepts("8004"))
        XCTAssertFalse(dpd.accepts("75001"))

        let mondialRelay = try XCTUnwrap(
            catalog.requirements(for: .mondialRelay, trackingNumber: "76434219")
                .first(where: { $0.field == .dpdPostcode })
        )
        XCTAssertEqual(mondialRelay.placeholder, "75001")
        XCTAssertEqual(mondialRelay.maxLength, 5)
        XCTAssertEqual(mondialRelay.normalizedValue("75 A001 9"), "75001")
        XCTAssertTrue(mondialRelay.accepts("75001"))
        XCTAssertFalse(mondialRelay.accepts("8004"))

        let gls = try XCTUnwrap(
            catalog.requirements(for: .glsCh, trackingNumber: "993990103198")
                .first(where: { $0.field == .dpdPostcode })
        )
        XCTAssertTrue(gls.accepts("8000"))
        XCTAssertFalse(gls.accepts("75001"))

        let heppner = try XCTUnwrap(
            catalog.requirements(for: .heppner, trackingNumber: "23456789")
                .first(where: { $0.field == .dpdPostcode })
        )
        XCTAssertTrue(heppner.accepts("1201"))
        XCTAssertTrue(heppner.accepts("75001"))

        let paack = try XCTUnwrap(
            catalog.requirements(for: .paack, trackingNumber: "PAACK12345")
                .first(where: { $0.field == .dpdPostcode })
        )
        XCTAssertTrue(paack.accepts("1234-567"))
        XCTAssertFalse(paack.accepts("12--345"))
        XCTAssertFalse(paack.accepts("ABC"))
        XCTAssertEqual(paack.normalizedValue("sw1a 1aa"), "SW1A1AA")
    }

    func testBuildsUsableCarrierLinks() throws {
        var parcel = Parcel(
            id: UUID(),
            trackingNumber: "4TZKO15679059600",
            label: "Furniture",
            carrier: .cChezVous,
            createdAt: "2026-08-30T13:00:00Z",
            syncStatus: .ok,
            notificationsMuted: false
        )
        XCTAssertEqual(
            try XCTUnwrap(catalog.trackingLinks(for: parcel, language: .fr).first).url.absoluteString,
            "https://www.cchezvous.fr/suivi-colis/4TZKO156790--59600"
        )

        parcel.trackingNumber = "PAACK12345"
        parcel.carrier = .paack
        parcel.dpdPostcode = "75001"
        XCTAssertEqual(
            try XCTUnwrap(catalog.trackingLinks(for: parcel, language: .fr).first).url.absoluteString,
            "https://mydeliveries.paack.app/tracking?tracking_number=PAACK12345"
        )
    }

    func testPlanzerLinkKeepsQuickpacIdentityFor44Barcode() {
        let parsed = catalog.parse(
            "https://tracking.app.planzer.ch/delivery/info?deliveryNumber=443412345678901234"
        )
        XCTAssertEqual(parsed.carrier, .quickpac)
        XCTAssertEqual(parsed.source, .link)
    }

    func testFormattingAndS10Checksum() {
        XCTAssertEqual(CarrierCatalog.format("993412345678901234"), "99.34.123456.78901234")
        XCTAssertTrue(CarrierCatalog.isValidS10("RA123456785CH"))
        XCTAssertFalse(CarrierCatalog.isValidS10("RA123456789CH"))
    }

    func testAcceptsASelectableCarrierThatWasNotCompiledIntoTheApp() throws {
        let dynamic = try CarrierCatalog(data: Self.futureCatalogData)
        let futureCarrier = CarrierID(rawValue: "future-express")

        XCTAssertFalse(CarrierID.allCases.contains(futureCarrier))
        XCTAssertTrue(dynamic.selectableCarriers.contains(futureCarrier))
        XCTAssertEqual(dynamic.info(for: futureCarrier).displayName, "Future Express")
        XCTAssertEqual(dynamic.detect("FX12345678").carrier, futureCarrier)
        XCTAssertEqual(
            dynamic.parse("https://tracking.future.example/FX12345678").carrier,
            futureCarrier
        )
    }

    @MainActor
    func testRefreshesCachesAndConditionallyRevalidatesTheRemoteCatalog() async throws {
        let cacheURL = FileManager.default.temporaryDirectory
            .appending(path: "carrier-catalog-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: cacheURL) }

        let firstRecorder = CatalogRequestRecorder()
        let first = try CarrierCatalog(
            data: Self.bundledCatalogData,
            cacheURL: cacheURL,
            loader: { request in
                await firstRecorder.record(request)
                return (
                    Self.futureCatalogData,
                    Self.response(for: request, status: 200, headers: ["ETag": "\"future-v1\""])
                )
            }
        )

        let firstResult = await first.refresh(
            from: URL(string: "https://delivery.example")!,
            force: true
        )
        XCTAssertEqual(firstResult, .updated)
        let futureCarrier = CarrierID(rawValue: "future-express")
        XCTAssertEqual(first.info(for: futureCarrier).displayName, "Future Express")
        XCTAssertTrue(FileManager.default.fileExists(atPath: cacheURL.path))
        let firstRequest = await firstRecorder.lastRequest
        XCTAssertEqual(firstRequest?.url?.absoluteString, "https://delivery.example/api/carriers")
        XCTAssertNil(firstRequest?.value(forHTTPHeaderField: "If-None-Match"))

        let revalidationRecorder = CatalogRequestRecorder()
        let cached = CarrierCatalog(
            bundle: .main,
            cacheURL: cacheURL,
            loader: { request in
                await revalidationRecorder.record(request)
                return (Data(), Self.response(for: request, status: 304))
            }
        )
        XCTAssertEqual(cached.info(for: futureCarrier).displayName, "Future Express")
        let cachedResult = await cached.refresh(
            from: URL(string: "https://delivery.example")!,
            force: true
        )
        XCTAssertEqual(cachedResult, .notModified)
        let revalidationRequest = await revalidationRecorder.lastRequest
        XCTAssertEqual(
            revalidationRequest?.value(forHTTPHeaderField: "If-None-Match"),
            "\"future-v1\""
        )
    }

    @MainActor
    func testRejectsAnInvalidRemoteCatalogAndKeepsTheBundledDefinitions() async throws {
        let original = try CarrierCatalog(
            data: Self.bundledCatalogData,
            loader: { request in
                let invalid = Data("{\"x-carriers\":{}}".utf8)
                return (invalid, Self.response(for: request, status: 200))
            }
        )

        let result = await original.refresh(
            from: URL(string: "https://delivery.example")!,
            force: true
        )
        XCTAssertEqual(result, .failed)
        XCTAssertEqual(original.info(for: .amazonLogistics).displayName, "Amazon Shipping")
    }

    private static var bundledCatalogData: Data {
        get throws {
            let url = try XCTUnwrap(
                Bundle.main.url(forResource: "CarrierCatalog", withExtension: "json")
            )
            return try Data(contentsOf: url)
        }
    }

    private static let futureCatalogData = Data("""
    {
      "version": "test-v1",
      "x-carriers": {
        "future-express": {
          "displayName": "Future Express",
          "color": "#123456",
          "selectable": true,
          "timezone": "Europe/Paris",
          "tracking": { "mode": "automatic", "adapter": "future-express" },
          "trackingUrlTemplate": "https://tracking.future.example/{trackingNumber}",
          "linkRules": [{
            "domains": ["tracking.future.example"],
            "path": "^/([^/?#]+)$"
          }],
          "detectionRules": [{
            "pattern": "^FX\\\\d{8}$",
            "confidence": "high"
          }]
        },
        "unknown": {
          "displayName": "Carrier",
          "color": "#8e8e93",
          "selectable": false,
          "timezone": "UTC",
          "tracking": { "mode": "link-only", "adapter": null },
          "linkRules": [],
          "detectionRules": []
        }
      }
    }
    """.utf8)

    private static func response(
        for request: URLRequest,
        status: Int,
        headers: [String: String]? = nil
    ) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
    }
}

private actor CatalogRequestRecorder {
    private var requests: [URLRequest] = []

    func record(_ request: URLRequest) {
        requests.append(request)
    }

    var lastRequest: URLRequest? { requests.last }
}
