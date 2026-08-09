import UserNotifications
import XCTest
@testable import SwissDeliveryTracker

final class NotificationLogicTests: XCTestCase {
    func testPresetsMatchStageSetsRegardlessOfOrder() {
        XCTAssertEqual(NotificationPreset.matching(NotificationPreset.all.stages.reversed()), .all)
        XCTAssertEqual(NotificationPreset.matching(NotificationPreset.important.stages.shuffled()), .important)
        XCTAssertEqual(NotificationPreset.matching(NotificationPreset.deliveryDay.stages.reversed()), .deliveryDay)
    }

    func testUnknownStageCombinationFallsBackToAllPreset() {
        XCTAssertEqual(NotificationPreset.matching([.customs, .delivered]), .all)
    }

    func testPreferencesDraftRoundTripsPresetAndQuietHours() {
        let original = NotificationPreferences(
            enabledStages: NotificationPreset.important.stages,
            quietHoursStart: "23:15",
            quietHoursEnd: "06:45",
            timezone: "Europe/Zurich"
        )

        let draft = NotificationPreferencesDraft(preferences: original, calendar: utcCalendar)
        let saved = draft.preferences(timezone: original.timezone, calendar: utcCalendar)

        XCTAssertEqual(draft.preset, .important)
        XCTAssertTrue(draft.quietHoursEnabled)
        XCTAssertEqual(saved, original)
    }

    func testDisablingQuietHoursClearsBothTimes() {
        var draft = NotificationPreferencesDraft(
            preferences: NotificationPreferences(
                enabledStages: NotificationPreset.deliveryDay.stages,
                quietHoursStart: "22:00",
                quietHoursEnd: "08:00",
                timezone: "Europe/Zurich"
            ),
            calendar: utcCalendar
        )
        draft.quietHoursEnabled = false

        let saved = draft.preferences(timezone: "Europe/Zurich", calendar: utcCalendar)

        XCTAssertNil(saved.quietHoursStart)
        XCTAssertNil(saved.quietHoursEnd)
        XCTAssertEqual(saved.enabledStages, NotificationPreset.deliveryDay.stages)
    }

    func testDeviceNotificationStateRequiresPermissionRegistrationAndNoOptOut() {
        XCTAssertTrue(NotificationDevicePolicy.isEnabled(
            isDemo: false,
            status: .authorized,
            optedOut: false,
            nativePushRegistered: true,
            demoNotificationsEnabled: false
        ))
        XCTAssertFalse(NotificationDevicePolicy.isEnabled(
            isDemo: false,
            status: .denied,
            optedOut: false,
            nativePushRegistered: true,
            demoNotificationsEnabled: false
        ))
        XCTAssertFalse(NotificationDevicePolicy.isEnabled(
            isDemo: false,
            status: .authorized,
            optedOut: true,
            nativePushRegistered: true,
            demoNotificationsEnabled: false
        ))
        XCTAssertFalse(NotificationDevicePolicy.isEnabled(
            isDemo: false,
            status: .authorized,
            optedOut: false,
            nativePushRegistered: false,
            demoNotificationsEnabled: false
        ))
    }

    func testDemoNotificationStateDoesNotDependOnAPNS() {
        XCTAssertTrue(NotificationDevicePolicy.isEnabled(
            isDemo: true,
            status: .denied,
            optedOut: true,
            nativePushRegistered: false,
            demoNotificationsEnabled: true
        ))
        XCTAssertFalse(NotificationDevicePolicy.isEnabled(
            isDemo: true,
            status: .authorized,
            optedOut: false,
            nativePushRegistered: true,
            demoNotificationsEnabled: false
        ))
    }

    func testRemoteRegistrationPolicyAcceptsProvisionalPermission() {
        XCTAssertTrue(NotificationDevicePolicy.shouldRegisterForRemoteNotifications(
            status: .provisional,
            optedOut: false
        ))
        XCTAssertFalse(NotificationDevicePolicy.shouldRegisterForRemoteNotifications(
            status: .notDetermined,
            optedOut: false
        ))
        XCTAssertFalse(NotificationDevicePolicy.shouldRegisterForRemoteNotifications(
            status: .authorized,
            optedOut: true
        ))
    }

    func testOnboardingOnlyAppearsForNewSignedInAccounts() {
        XCTAssertTrue(NotificationOnboardingPolicy.shouldPresent(
            isAuthenticated: true,
            isDemo: false,
            completed: false
        ))
        XCTAssertFalse(NotificationOnboardingPolicy.shouldPresent(
            isAuthenticated: false,
            isDemo: false,
            completed: false
        ))
        XCTAssertFalse(NotificationOnboardingPolicy.shouldPresent(
            isAuthenticated: true,
            isDemo: true,
            completed: false
        ))
        XCTAssertFalse(NotificationOnboardingPolicy.shouldPresent(
            isAuthenticated: true,
            isDemo: false,
            completed: true
        ))
    }

    private var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }
}
