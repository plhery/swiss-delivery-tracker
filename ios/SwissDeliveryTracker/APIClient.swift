import Foundation
import UIKit

enum DeliveryAPIError: LocalizedError {
    case authenticationExpired
    case invalidResponse
    case service(String)

    var errorDescription: String? {
        switch self {
        case .authenticationExpired: "Your sign-in expired. Please sign in again."
        case .invalidResponse: "The delivery service returned an invalid response."
        case .service(let message): message
        }
    }
}

@MainActor
final class DeliveryAPIClient {
    private let configuration: AppConfiguration
    private unowned let session: SessionStore

    init(configuration: AppConfiguration, session: SessionStore) {
        self.configuration = configuration
        self.session = session
    }

    func listPackages() async throws -> [Parcel] {
        let response: PackageListResponse = try await request("/api/packages?includeArchived=true")
        return response.packages
    }

    func add(_ input: NewParcelRequest) async throws -> Parcel {
        try await request("/api/packages", method: "POST", body: input)
    }

    func rename(id: UUID, label: String) async throws -> Parcel {
        try await request(
            "/api/packages/\(id.uuidString)",
            method: "PATCH",
            body: ["label": label]
        )
    }

    func setMuted(id: UUID, muted: Bool) async throws -> Parcel {
        try await request(
            "/api/packages/\(id.uuidString)/notifications",
            method: "PATCH",
            body: ["muted": muted]
        )
    }

    func archive(id: UUID) async throws {
        let _: OKResponse = try await request("/api/packages/\(id.uuidString)", method: "DELETE")
    }

    func restore(id: UUID) async throws -> Parcel {
        try await request("/api/packages/\(id.uuidString)/restore", method: "POST")
    }

    func permanentlyDelete(id: UUID) async throws {
        let _: OKResponse = try await request(
            "/api/packages/\(id.uuidString)/permanent",
            method: "DELETE"
        )
    }

    func refreshAll() async throws {
        let _: QueueResponse = try await request("/api/sync", method: "POST")
    }

    func refresh(id: UUID) async throws {
        let _: QueueResponse = try await request("/api/packages/\(id.uuidString)/sync", method: "POST")
    }

    func notificationPreferences() async throws -> NotificationPreferences {
        try await request("/api/push/preferences")
    }

    func saveNotificationPreferences(_ value: NotificationPreferences) async throws -> NotificationPreferences {
        try await request("/api/push/preferences", method: "PATCH", body: value)
    }

    func registerNativePushToken(
        _ token: String,
        language: AppLanguage,
        sendTest: Bool
    ) async throws -> Bool {
        struct Body: Codable {
            let token: String
            let environment: String
            let locale: String
            let deviceName: String
            let sendTest: Bool
        }
        struct Response: Codable { let ok: Bool; let testSent: Bool }
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        let response: Response = try await request(
            "/api/push/devices",
            method: "POST",
            body: Body(
                token: token,
                environment: environment,
                locale: language.rawValue,
                deviceName: UIDevice.current.name,
                sendTest: sendTest
            )
        )
        return response.testSent
    }

    func unregisterNativePushToken(_ token: String) async throws {
        let _: OKResponse = try await request(
            "/api/push/devices",
            method: "DELETE",
            body: ["token": token]
        )
    }

    func exportAccount() async throws -> Data {
        try await rawRequest("/api/account/export").0
    }

    func deleteAccount(confirmation: String) async throws {
        let _: OKResponse = try await request(
            "/api/account",
            method: "DELETE",
            body: ["confirmation": confirmation]
        )
    }

    private func request<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String = "GET",
        body: Body?
    ) async throws -> T {
        let encoded = try body.map { try JSONEncoder.deliveryTracker.encode($0) }
        let (data, _) = try await rawRequest(path, method: method, body: encoded)
        do {
            return try JSONDecoder.deliveryTracker.decode(T.self, from: data)
        } catch {
            throw DeliveryAPIError.invalidResponse
        }
    }

    private func request<T: Decodable>(
        _ path: String,
        method: String = "GET"
    ) async throws -> T {
        try await request(path, method: method, body: Optional<String>.none)
    }

    private func rawRequest(
        _ path: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL)?.absoluteURL else {
            throw DeliveryAPIError.invalidResponse
        }

        func perform(token: String?) async throws -> (Data, HTTPURLResponse) {
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.httpBody = body
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 30
            request.setValue("XMLHttpRequest", forHTTPHeaderField: "X-Requested-With")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw DeliveryAPIError.invalidResponse }
            return (data, http)
        }

        var token = try await session.accessToken()
        var result = try await perform(token: token)
        if result.1.statusCode == 401 || result.1.statusCode == 403 {
            token = try? await session.accessToken(forceRefresh: true)
            if token != nil { result = try await perform(token: token) }
        }
        if result.1.statusCode == 401 || result.1.statusCode == 403 {
            session.forceSignOut()
            throw DeliveryAPIError.authenticationExpired
        }
        guard (200..<300).contains(result.1.statusCode) else {
            let error = try? JSONDecoder().decode(APIErrorPayload.self, from: result.0)
            throw DeliveryAPIError.service(
                error?.error ?? "Delivery service failed (\(result.1.statusCode))."
            )
        }
        return result
    }
}

private struct APIErrorPayload: Codable {
    let error: String?
}
