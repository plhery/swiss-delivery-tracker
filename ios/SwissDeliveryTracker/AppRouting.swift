import Foundation

enum NativeRoute: Equatable {
    case parcel(UUID)
    case add(trackingInput: String)

    init?(url: URL) {
        guard url.scheme?.lowercased() == OAuthFlow.callbackScheme else { return nil }
        switch url.host?.lowercased() {
        case "parcel":
            guard let raw = url.pathComponents.last,
                  let parcelID = UUID(uuidString: raw) else { return nil }
            self = .parcel(parcelID)
        case "add":
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let tracking = components?.queryItems?.first(where: { $0.name == "tracking" })?.value ?? ""
            self = .add(trackingInput: tracking)
        default:
            return nil
        }
    }

    init?(remoteNotification payload: [AnyHashable: Any]) {
        guard let raw = payload["parcel_id"] as? String,
              let parcelID = UUID(uuidString: raw) else { return nil }
        self = .parcel(parcelID)
    }
}

enum OAuthFlow {
    static let callbackScheme = "swissdeliverytracker"
    static let callbackHost = "auth-callback"

    static var callbackURL: URL {
        URL(string: "\(callbackScheme)://\(callbackHost)")!
    }

    static func authorizationURL(
        baseURL: URL,
        provider: String,
        codeChallenge: String
    ) -> URL? {
        guard var components = URLComponents(
            url: baseURL.appending(path: "auth/v1/authorize"),
            resolvingAgainstBaseURL: false
        ) else { return nil }
        components.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "redirect_to", value: callbackURL.absoluteString),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "s256"),
        ]
        return components.url
    }

    static func authorizationCode(from callback: URL) -> String? {
        guard callback.scheme?.lowercased() == callbackScheme,
              callback.host?.lowercased() == callbackHost,
              let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else { return nil }
        return code
    }
}
