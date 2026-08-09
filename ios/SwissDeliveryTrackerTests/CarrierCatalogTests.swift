import XCTest
@testable import SwissDeliveryTracker

final class CarrierCatalogTests: XCTestCase {
    private let catalog = CarrierCatalog.shared

    func testDetectsHighConfidenceCarriers() {
        XCTAssertEqual(catalog.detect("1Z999AA10123456784").carrier, .ups)
        XCTAssertEqual(catalog.detect("443412345678901234").carrier, .quickpac)
        XCTAssertEqual(catalog.detect("RA123456785CH").carrier, .swissPost)
    }

    func testKeepsAmbiguousCarrierForConfirmation() {
        let result = catalog.detect("12345678901234")
        XCTAssertEqual(result.carrier, .unknown)
        XCTAssertEqual(result.confidence, .low)
        XCTAssertTrue(result.candidates.contains(.dpd))
    }

    func testParsesKnownCarrierLink() {
        let parsed = catalog.parse("Track it: https://www.ups.com/track?tracknum=1Z999AA10123456784")
        XCTAssertEqual(parsed.trackingNumber, "1Z999AA10123456784")
        XCTAssertEqual(parsed.carrier, .ups)
        XCTAssertEqual(parsed.source, .link)
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
