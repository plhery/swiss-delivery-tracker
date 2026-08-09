import XCTest
@testable import SwissDeliveryTracker

final class AppRoutingTests: XCTestCase {
    func testParsesParcelDeepLink() {
        let parcelID = UUID()
        let url = URL(string: "swissdeliverytracker://parcel/\(parcelID.uuidString)")!

        XCTAssertEqual(NativeRoute(url: url), .parcel(parcelID))
    }

    func testParsesAddDeepLinkAndDecodesTrackingInput() {
        let url = URL(string: "swissdeliverytracker://add?tracking=1Z999%20AA")!

        XCTAssertEqual(NativeRoute(url: url), .add(trackingInput: "1Z999 AA"))
    }

    func testRejectsMalformedOrUnrelatedDeepLinks() {
        XCTAssertNil(NativeRoute(url: URL(string: "https://parcel/not-ours")!))
        XCTAssertNil(NativeRoute(url: URL(string: "swissdeliverytracker://parcel/not-a-uuid")!))
        XCTAssertNil(NativeRoute(url: OAuthFlow.callbackURL))
    }

    func testParsesParcelNotificationPayload() {
        let parcelID = UUID()

        XCTAssertEqual(
            NativeRoute(remoteNotification: ["parcel_id": parcelID.uuidString]),
            .parcel(parcelID)
        )
        XCTAssertNil(NativeRoute(remoteNotification: ["parcel_id": "not-a-uuid"]))
        XCTAssertNil(NativeRoute(remoteNotification: ["other": parcelID.uuidString]))
    }

    func testGoogleAuthorizationURLReturnsToNativeAppWithPKCE() throws {
        let url = try XCTUnwrap(OAuthFlow.authorizationURL(
            baseURL: URL(string: "https://example.supabase.co")!,
            provider: "google",
            codeChallenge: "challenge-value"
        ))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })

        XCTAssertEqual(components.path, "/auth/v1/authorize")
        XCTAssertEqual(query["provider"]!, "google")
        XCTAssertEqual(query["redirect_to"]!, OAuthFlow.callbackURL.absoluteString)
        XCTAssertEqual(query["code_challenge"]!, "challenge-value")
        XCTAssertEqual(query["code_challenge_method"]!, "s256")
    }

    func testOAuthCodeOnlyAcceptsTheExpectedNativeCallback() {
        XCTAssertEqual(
            OAuthFlow.authorizationCode(
                from: URL(string: "swissdeliverytracker://auth-callback?code=valid-code")!
            ),
            "valid-code"
        )
        XCTAssertNil(OAuthFlow.authorizationCode(
            from: URL(string: "swissdeliverytracker://other?code=valid-code")!
        ))
        XCTAssertNil(OAuthFlow.authorizationCode(
            from: URL(string: "https://auth-callback?code=valid-code")!
        ))
        XCTAssertNil(OAuthFlow.authorizationCode(
            from: URL(string: "swissdeliverytracker://auth-callback?code=")!
        ))
    }
}
