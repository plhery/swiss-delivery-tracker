import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

struct AuthUser: Codable, Equatable, Sendable {
    let id: UUID
    let email: String?
    let isAnonymous: Bool?
}

struct AuthSession: Codable, Sendable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int
    let expiresAt: Int?
    let refreshToken: String
    let user: AuthUser

    var expirationDate: Date {
        if let expiresAt { return Date(timeIntervalSince1970: TimeInterval(expiresAt)) }
        return Date().addingTimeInterval(TimeInterval(expiresIn))
    }
}

enum AuthenticationState {
    case loading
    case welcome
    case demo
    case unconfigured
    case signedOut
    case signedIn(AuthUser)
}

enum AuthenticationError: LocalizedError {
    case notConfigured
    case invalidResponse
    case missingSession
    case oauthCancelled
    case requestFailed(Int)
    case secureRequestFailed
    case sessionSaveFailed
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Authentication is not configured."
        case .invalidResponse: "The authentication service returned an invalid response."
        case .missingSession: "The sign-in code did not create a session."
        case .oauthCancelled: "Sign-in was cancelled."
        case .requestFailed(let status): "Sign-in failed (\(status))."
        case .secureRequestFailed: "A secure sign-in request could not be created."
        case .sessionSaveFailed: "The secure session could not be saved."
        case .server(let message): message
        }
    }
}

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var state: AuthenticationState = .loading

    let configuration: AppConfiguration
    private let keychain = KeychainStore(service: "com.plhery.SwissDeliveryTracker.auth")
    private let experienceKey = "sdt.native.experience.v1"
    private var session: AuthSession?
    private var refreshTask: Task<Void, Error>?
    private var webAuthenticationSession: ASWebAuthenticationSession?

    init(configuration: AppConfiguration = .current) {
        self.configuration = configuration
    }

    var user: AuthUser? {
        if case .signedIn(let user) = state { return user }
        return nil
    }

    var isAuthenticated: Bool {
        if case .signedIn = state { return true }
        if case .demo = state { return true }
        return false
    }

    var isDemo: Bool {
        if case .demo = state { return true }
        return false
    }

    func bootstrap() async {
        if configuration.authenticationConfigured,
           let stored: AuthSession = keychain.load() {
            session = stored
            if stored.expirationDate.timeIntervalSinceNow < 60 {
                do {
                    try await refreshSession()
                } catch {
                    clearLocalSession()
                }
            } else if stored.user.isAnonymous == true {
                clearLocalSession()
            } else {
                rememberExperience("account")
                state = .signedIn(stored.user)
            }
            return
        }

        switch UserDefaults.standard.string(forKey: experienceKey) {
        case "demo": state = .demo
        case "account": state = configuration.authenticationConfigured ? .signedOut : .unconfigured
        default: state = .welcome
        }
    }

    func enterDemo() {
        rememberExperience("demo")
        state = .demo
    }

    func showSignIn() {
        rememberExperience("account")
        state = configuration.authenticationConfigured ? .signedOut : .unconfigured
    }

    func showWelcome() {
        UserDefaults.standard.removeObject(forKey: experienceKey)
        state = .welcome
    }

    func sendCode(to email: String) async throws {
        let body = ["email": email, "create_user": true] as [String: Any]
        _ = try await authRequest(
            path: "otp",
            method: "POST",
            jsonObject: body,
            response: EmptyAuthResponse.self
        )
    }

    func verifyCode(email: String, code: String) async throws {
        let result = try await authRequest(
            path: "verify",
            method: "POST",
            jsonObject: ["email": email, "token": code, "type": "email"],
            response: AuthSession.self
        )
        try accept(result)
    }

    func signInWithGoogle() async throws {
        guard let base = configuration.supabaseURL else { throw AuthenticationError.notConfigured }
        let verifier = try Self.randomVerifier()
        let challenge = Self.codeChallenge(for: verifier)
        guard let authorizationURL = OAuthFlow.authorizationURL(
            baseURL: base,
            provider: "google",
            codeChallenge: challenge
        ) else { throw AuthenticationError.invalidResponse }
        let callback = try await startWebAuthentication(url: authorizationURL)
        guard let code = OAuthFlow.authorizationCode(from: callback) else {
            throw AuthenticationError.invalidResponse
        }
        let result = try await authRequest(
            path: "token?grant_type=pkce",
            method: "POST",
            jsonObject: ["auth_code": code, "code_verifier": verifier],
            response: AuthSession.self
        )
        try accept(result)
    }

    func accessToken(forceRefresh: Bool = false) async throws -> String? {
        guard configuration.mode == .api else { return nil }
        guard let session else { return nil }
        if forceRefresh || session.expirationDate.timeIntervalSinceNow < 60 {
            try await refreshSession()
        }
        return self.session?.accessToken
    }

    func signOut() async throws {
        if let token = session?.accessToken {
            _ = try? await authRequest(
                path: "logout?scope=local",
                method: "POST",
                jsonObject: [:],
                response: EmptyAuthResponse.self,
                bearer: token
            )
        }
        clearLocalSession()
    }

    func forceSignOut() {
        clearLocalSession()
    }

    private func refreshSession() async throws {
        if let refreshTask {
            try await refreshTask.value
            return
        }
        guard let refreshToken = session?.refreshToken else { throw AuthenticationError.missingSession }
        let task = Task<Void, Error> { [weak self] in
            guard let self else { throw AuthenticationError.missingSession }
            let refreshed = try await self.authRequest(
                path: "token?grant_type=refresh_token",
                method: "POST",
                jsonObject: ["refresh_token": refreshToken],
                response: AuthSession.self
            )
            try Task.checkCancellation()
            try self.accept(refreshed)
        }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }

    private func accept(_ next: AuthSession) throws {
        guard next.user.isAnonymous != true else { throw AuthenticationError.missingSession }
        try keychain.save(next)
        session = next
        rememberExperience("account")
        state = .signedIn(next.user)
    }

    private func clearLocalSession() {
        refreshTask?.cancel()
        refreshTask = nil
        session = nil
        keychain.delete()
        state = configuration.authenticationConfigured ? .signedOut : .unconfigured
    }

    private func rememberExperience(_ value: String) {
        UserDefaults.standard.set(value, forKey: experienceKey)
    }

    private func authRequest<T: Decodable>(
        path: String,
        method: String,
        jsonObject: [String: Any],
        response: T.Type,
        bearer: String? = nil
    ) async throws -> T {
        guard let base = configuration.supabaseURL else { throw AuthenticationError.notConfigured }
        guard let url = URL(string: "auth/v1/\(path)", relativeTo: base)?.absoluteURL else {
            throw AuthenticationError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = try JSONSerialization.data(withJSONObject: jsonObject)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(configuration.supabasePublishableKey, forHTTPHeaderField: "apikey")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let (data, rawResponse) = try await URLSession.shared.data(for: request)
        guard let http = rawResponse as? HTTPURLResponse else { throw AuthenticationError.invalidResponse }
        if !(200..<300).contains(http.statusCode) {
            let payload = (try? JSONDecoder().decode(AuthErrorPayload.self, from: data))
            if let message = payload?.errorDescription ?? payload?.message ?? payload?.msg {
                throw AuthenticationError.server(message)
            }
            throw AuthenticationError.requestFailed(http.statusCode)
        }
        if T.self == EmptyAuthResponse.self, data.isEmpty {
            return EmptyAuthResponse() as! T
        }
        return try JSONDecoder.deliveryTracker.decode(T.self, from: data)
    }

    private func startWebAuthentication(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: OAuthFlow.callbackScheme
            ) { [weak self] callback, error in
                defer { self?.webAuthenticationSession = nil }
                if let callback {
                    continuation.resume(returning: callback)
                } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                    continuation.resume(throwing: AuthenticationError.oauthCancelled)
                } else {
                    continuation.resume(throwing: error ?? AuthenticationError.invalidResponse)
                }
            }
            session.presentationContextProvider = AuthenticationAnchorProvider.shared
            session.prefersEphemeralWebBrowserSession = false
            webAuthenticationSession = session
            if !session.start() {
                webAuthenticationSession = nil
                continuation.resume(throwing: AuthenticationError.invalidResponse)
            }
        }
    }

    private static func randomVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 48)
        let count = bytes.count
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw AuthenticationError.secureRequestFailed
        }
        return Data(bytes).base64URLEncodedString()
    }

    private static func codeChallenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    }
}

private struct EmptyAuthResponse: Codable {
    init() {}
}

private struct AuthErrorPayload: Codable {
    let message: String?
    let msg: String?
    let errorDescription: String?
}

private final class AuthenticationAnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthenticationAnchorProvider()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

private struct KeychainStore {
    let service: String
    private let account = "session"

    func save<T: Encodable>(_ value: T) throws {
        let data = try JSONEncoder.deliveryTracker.encode(value)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw AuthenticationError.sessionSaveFailed
        }
    }

    func load<T: Decodable>() -> T? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder.deliveryTracker.decode(T.self, from: data)
    }

    func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
