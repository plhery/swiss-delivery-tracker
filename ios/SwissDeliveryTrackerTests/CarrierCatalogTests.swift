import XCTest
@testable import SwissDeliveryTracker

final class CarrierCatalogTests: XCTestCase {
    private let catalog = CarrierCatalog.shared

    func testDetectsHighConfidenceCarriers() {
        XCTAssertEqual(catalog.detect("1Z999AA10123456784").carrier, .ups)
        XCTAssertEqual(catalog.detect("443412345678901234").carrier, .quickpac)
        XCTAssertEqual(catalog.detect("RA123456785CH").carrier, .swissPost)
        XCTAssertEqual(catalog.detect("250803383035673").carrier, .dpdFr)
        XCTAssertEqual(catalog.detect("CC200000000401").carrier, .relaisColis)
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
        ] {
            XCTAssertTrue(catalog.selectableCarriers.contains(carrier), carrier.rawValue)
            XCTAssertTrue(catalog.tracksAutomatically(carrier), carrier.rawValue)
        }
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
}
