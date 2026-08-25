import XCTest
@testable import SwissDeliveryTracker

final class ParcelLogicTests: XCTestCase {
    func testDecodesSharedAPIContractFixture() throws {
        struct Fixture: Decodable {
            let packageList: PackageListResponse
            let queue: QueueResponse
            let job: SyncJobResponse
        }
        let url = try XCTUnwrap(Bundle.main.url(forResource: "ContractFixtures", withExtension: "json"))
        let fixture = try JSONDecoder.deliveryTracker.decode(
            Fixture.self,
            from: Data(contentsOf: url)
        )

        XCTAssertEqual(fixture.packageList.packages.first?.carrier, .swissPost)
        XCTAssertEqual(fixture.packageList.packages.first?.trackingEvents.first?.stage, .inTransit)
        XCTAssertEqual(fixture.queue.jobIDs.count, 1)
        XCTAssertEqual(fixture.job.status, .succeeded)
        XCTAssertEqual(fixture.job.result?.checked, 1)
    }

    func testDecodesProductionPackagePayload() throws {
        let packageID = UUID()
        let eventID = UUID()
        let json = """
        {
          "packages": [{
            "id": "\(packageID.uuidString)",
            "tracking_number": "1Z999AA10123456784",
            "label": "Test parcel",
            "carrier": "ups",
            "created_at": "2026-08-01T10:00:00Z",
            "expected_delivery": null,
            "last_status_text": "In transit",
            "last_synced_at": "2026-08-09T10:00:00Z",
            "sync_status": "ok",
            "sync_error": null,
            "tracking_url": "https://www.ups.com/track?tracknum=1Z999AA10123456784",
            "dpd_postcode": null,
            "carrier_data": null,
            "archived_at": null,
            "notifications_muted": false,
            "tracking_events": [{
              "id": "\(eventID.uuidString)",
              "package_id": "\(packageID.uuidString)",
              "stage": "in_transit",
              "description": "In transit",
              "location": null,
              "occurred_at": "2026-08-09T10:00:00Z"
            }]
          }]
        }
        """

        let response = try JSONDecoder.deliveryTracker.decode(
            PackageListResponse.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(response.packages.first?.trackingURL, "https://www.ups.com/track?tracknum=1Z999AA10123456784")
        XCTAssertEqual(response.packages.first?.trackingEvents.first?.packageID, packageID)
    }

    func testDecodesNullTrackingEventsAsEmptyHistory() throws {
        let json = """
        {
          "packages": [{
            "id": "\(UUID().uuidString)",
            "tracking_number": "999999999999999999",
            "label": "New parcel",
            "carrier": "swiss-post",
            "created_at": "2026-08-09T10:00:00Z",
            "expected_delivery": null,
            "last_status_text": null,
            "last_synced_at": null,
            "sync_status": "waiting",
            "sync_error": null,
            "tracking_url": null,
            "dpd_postcode": null,
            "archived_at": null,
            "notifications_muted": false,
            "tracking_events": null
          }]
        }
        """

        let response = try JSONDecoder.deliveryTracker.decode(
            PackageListResponse.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(response.packages.first?.trackingEvents, [])
    }

    func testGeneratedRequestModelsEncodeAPIFieldNamesAndEnumValues() throws {
        let packageRequest = CreatePackageRequest(
            trackingNumber: "99.34.123456.12345678",
            carrier: .swissPost,
            trackingURL: "https://service.post.ch/parcel/123"
        )
        let packageJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: JSONEncoder.deliveryTracker.encode(packageRequest)
            ) as? [String: Any]
        )

        XCTAssertEqual(packageJSON["trackingNumber"] as? String, packageRequest.trackingNumber)
        XCTAssertEqual(packageJSON["carrier"] as? String, "swiss-post")
        XCTAssertEqual(packageJSON["trackingUrl"] as? String, packageRequest.trackingURL)
        XCTAssertNil(packageJSON["trackingURL"])

        let pushRequest = NativePushDeviceRequest(
            token: "device-token",
            environment: .production,
            locale: .fr,
            deviceName: "iPhone",
            sendTest: true
        )
        let pushJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: JSONEncoder.deliveryTracker.encode(pushRequest)
            ) as? [String: Any]
        )

        XCTAssertEqual(pushJSON["environment"] as? String, "production")
        XCTAssertEqual(pushJSON["locale"] as? String, "fr")
        XCTAssertEqual(pushJSON["sendTest"] as? Bool, true)

        let installationID = UUID()
        let parcelID = UUID()
        let liveRequest = LiveActivityUpdateTokenRequest(
            installationID: installationID,
            activityID: "activity-1",
            parcelID: parcelID,
            token: "ab".repeated(32),
            environment: .development,
            locale: .de
        )
        let liveJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: JSONEncoder.deliveryTracker.encode(liveRequest)
            ) as? [String: Any]
        )
        XCTAssertEqual(liveJSON["installationId"] as? String, installationID.uuidString)
        XCTAssertEqual(liveJSON["parcelId"] as? String, parcelID.uuidString)
        XCTAssertEqual(liveJSON["activityId"] as? String, "activity-1")
    }

    func testWidgetPrioritizesOutForDeliveryThenKeepsNextUp() {
        let nextUp = widgetParcel(label: "Next up", outForDelivery: false)
        let outForDelivery = widgetParcel(label: "Courier", outForDelivery: true)
        let later = widgetParcel(label: "Later", outForDelivery: false)

        XCTAssertEqual(
            DeliveryWidgetSelection.displayParcels(from: [nextUp, outForDelivery, later]),
            [outForDelivery, nextUp]
        )
    }

    func testWidgetShowsTwoOutForDeliveryParcelsBeforeOtherCandidates() {
        let nextUp = widgetParcel(label: "Next up", outForDelivery: false)
        let first = widgetParcel(label: "Courier one", outForDelivery: true)
        let second = widgetParcel(label: "Courier two", outForDelivery: true)

        XCTAssertEqual(
            DeliveryWidgetSelection.displayParcels(from: [nextUp, first, second]),
            [first, second]
        )
        XCTAssertEqual(
            DeliveryWidgetSelection.displayParcels(from: [nextUp]),
            [nextUp]
        )
    }

    func testDisablingWidgetRemovesSharedParcelSnapshot() throws {
        let suiteName = "DeliveryWidgetSharedStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = DeliveryWidgetSharedStore(defaults: defaults)
        let snapshot = DeliveryWidgetSnapshot(
            generatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            languageCode: "fr",
            parcels: [widgetParcel(label: "Private parcel", outForDelivery: true)]
        )

        XCTAssertTrue(store.isEnabled)
        store.setLanguageCode("fr")
        store.setLiveActivitiesEnabled(true)
        XCTAssertTrue(store.save(snapshot))
        XCTAssertEqual(store.snapshot, snapshot)

        store.setEnabled(false)

        XCTAssertFalse(store.isEnabled)
        XCTAssertTrue(store.liveActivitiesEnabled)
        XCTAssertNil(store.snapshot)
        XCTAssertEqual(store.languageCode, "fr")
    }

    func testDeliveryLiveActivityOnlyStartsForDeliveryDay() {
        XCTAssertNil(TrackingStage.pending.deliveryActivityPhase)
        XCTAssertNil(TrackingStage.registered.deliveryActivityPhase)
        XCTAssertNil(TrackingStage.accepted.deliveryActivityPhase)
        XCTAssertNil(TrackingStage.inTransit.deliveryActivityPhase)
        XCTAssertNil(TrackingStage.customs.deliveryActivityPhase)
        XCTAssertEqual(TrackingStage.outForDelivery.deliveryActivityPhase, .outForDelivery)
        XCTAssertEqual(TrackingStage.delivered.deliveryActivityPhase, .delivered)
        XCTAssertEqual(TrackingStage.failedAttempt.deliveryActivityPhase, .failedAttempt)
        XCTAssertEqual(TrackingStage.readyForPickup.deliveryActivityPhase, .readyForPickup)
        XCTAssertEqual(TrackingStage.returned.deliveryActivityPhase, .returned)
    }

    func testLiveActivityPayloadUsesParcelAsStableIdentity() throws {
        let parcelID = UUID()
        let attributes = DeliveryActivityAttributes(parcelID: parcelID)
        let state = DeliveryActivityAttributes.ContentState(
            parcel: DeliveryActivityParcel(
                id: parcelID,
                label: "Running shoes",
                carrier: "Swiss Post",
                status: "Out for delivery",
                detail: "Today, 14:00–16:00",
                phase: .outForDelivery
            ),
            languageCode: "en"
        )
        let attributesJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(attributes)) as? [String: Any]
        )
        let stateJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any]
        )
        let parcelJSON = try XCTUnwrap(stateJSON["parcel"] as? [String: Any])

        XCTAssertEqual(attributesJSON["parcelID"] as? String, parcelID.uuidString)
        XCTAssertEqual(parcelJSON["id"] as? String, parcelID.uuidString)
        XCTAssertEqual(parcelJSON["phase"] as? String, "out_for_delivery")
        XCTAssertEqual(stateJSON["languageCode"] as? String, "en")
        XCTAssertNil(parcelJSON["trackingNumber"])
    }

    func testPendingEventDoesNotOverrideCarrierProgress() {
        let id = UUID()
        let parcel = makeParcel(
            id: id,
            events: [
                event(id, .inTransit, "2026-08-08T10:00:00Z"),
                event(id, .pending, "2026-08-09T10:00:00Z"),
            ]
        )
        XCTAssertEqual(parcel.currentStage, .inTransit)
        XCTAssertEqual(parcel.currentEvent?.stage, .inTransit)
    }

    func testAttentionRulesMatchWebApp() {
        let now = DateParser.date("2026-08-09T12:00:00Z")!
        let id = UUID()
        let stalled = makeParcel(
            id: id,
            events: [event(id, .inTransit, "2026-08-04T10:00:00Z")]
        )
        XCTAssertEqual(stalled.attention(now: now), .stalled)

        var failed = stalled
        failed.syncStatus = .error
        XCTAssertEqual(failed.attention(now: now), .syncError)

        let announcedID = UUID()
        let announced = makeParcel(
            id: announcedID,
            events: [event(announcedID, .pending, "2026-08-01T08:00:00Z")]
        )
        XCTAssertNil(announced.attention(now: now))

        var oldUnannounced = announced
        oldUnannounced.syncStatus = .waiting
        XCTAssertEqual(oldUnannounced.displayStatus.key, "status.unannounced")
        XCTAssertEqual(oldUnannounced.attention(now: now), .notAnnounced)

        var recentUnannounced = oldUnannounced
        recentUnannounced.createdAt = "2026-08-08T12:01:00Z"
        XCTAssertNil(recentUnannounced.attention(now: now))
    }

    func testFiltersSearchCompactTrackingNumbers() {
        let parcel = makeParcel(trackingNumber: "99.34.123456.12345678")
        let result = ParcelOrganizer.visible(
            [parcel],
            query: "9934 123456",
            status: .all,
            carrier: nil,
            sort: .priority
        )
        XCTAssertEqual(result.map(\.id), [parcel.id])
    }

    func testArchivedParcelsAreNotActive() {
        var parcel = makeParcel()
        parcel.archivedAt = "2026-08-09T12:00:00Z"
        XCTAssertFalse(parcel.isActive)
        XCTAssertTrue(ParcelOrganizer.sections(from: [parcel]).contains { $0.kind == .archived })
    }

    private func makeParcel(
        id: UUID = UUID(),
        trackingNumber: String = "1Z999AA10123456784",
        events: [TrackingEvent] = []
    ) -> Parcel {
        Parcel(
            id: id,
            trackingNumber: trackingNumber,
            label: "Test parcel",
            carrier: .ups,
            createdAt: "2026-08-01T10:00:00Z",
            expectedDelivery: nil,
            lastStatusText: nil,
            lastSyncedAt: nil,
            syncStatus: .ok,
            syncError: nil,
            trackingURL: nil,
            dpdPostcode: nil,
            carrierData: nil,
            archivedAt: nil,
            notificationsMuted: false,
            trackingEvents: events
        )
    }

    private func event(_ packageID: UUID, _ stage: TrackingStage, _ occurredAt: String) -> TrackingEvent {
        TrackingEvent(
            id: UUID(), packageID: packageID, stage: stage,
            description: "Update", location: nil, occurredAt: occurredAt
        )
    }

    private func widgetParcel(label: String, outForDelivery: Bool) -> DeliveryWidgetParcel {
        DeliveryWidgetParcel(
            id: UUID(),
            label: label,
            carrier: "Swiss Post",
            trackingNumber: "99.34.123456.12345678",
            detail: "Today",
            isOutForDelivery: outForDelivery
        )
    }
}

private extension String {
    func repeated(_ count: Int) -> String {
        String(repeating: self, count: count)
    }
}
