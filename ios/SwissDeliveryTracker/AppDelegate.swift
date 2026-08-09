import UIKit
import UserNotifications

extension Notification.Name {
    static let didReceiveAPNSToken = Notification.Name("SDTDidReceiveAPNSToken")
    static let didFailAPNSRegistration = Notification.Name("SDTDidFailAPNSRegistration")
    static let didOpenParcelNotification = Notification.Name("SDTDidOpenParcelNotification")
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static private(set) var currentDeviceToken: String?
    static private(set) var pendingParcelID: UUID?

    static func clearDeviceToken() {
        currentDeviceToken = nil
    }

    static func consumePendingParcelID() -> UUID? {
        defer { pendingParcelID = nil }
        return pendingParcelID
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setBadgeCount(0)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        let value = token.map { String(format: "%02x", $0) }.joined()
        // Apple can rotate this opaque value. Keep only the current launch's
        // token in memory and forward every value received to the server.
        Self.currentDeviceToken = value
        NotificationCenter.default.post(name: .didReceiveAPNSToken, object: value)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .didFailAPNSRegistration, object: error)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        UNUserNotificationCenter.current().setBadgeCount(0)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let payload = response.notification.request.content.userInfo
        if case .parcel(let parcelID) = NativeRoute(remoteNotification: payload) {
            Self.pendingParcelID = parcelID
            NotificationCenter.default.post(name: .didOpenParcelNotification, object: parcelID)
        }
    }
}
