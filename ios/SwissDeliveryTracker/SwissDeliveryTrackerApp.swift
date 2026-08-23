import SwiftUI

@main
struct SwissDeliveryTrackerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session: SessionStore
    @StateObject private var parcels: ParcelStore
    @StateObject private var localizer: Localizer

    init() {
        let localizer = Localizer()
        let session = SessionStore(configuration: .current)
        _localizer = StateObject(wrappedValue: localizer)
        _session = StateObject(wrappedValue: session)
        _parcels = StateObject(wrappedValue: ParcelStore(
            configuration: .current,
            session: session,
            localizer: localizer
        ))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(parcels)
                .environmentObject(localizer)
                .environment(\.locale, localizer.language.locale)
                .tint(Brand.accent)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var parcels: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("sdt.notificationOnboardingCompleted.v1") private var notificationOnboardingCompleted = false
    @State private var showingNotificationOnboarding = false

    var body: some View {
        Group {
            switch session.state {
            case .loading:
                LaunchView()
            case .welcome:
                WelcomeView()
            case .unconfigured:
                SignInView(configured: false)
            case .signedOut:
                SignInView(configured: true)
            case .demo, .signedIn:
                ParcelListView()
            }
        }
        .task { await session.bootstrap() }
        .task(id: sessionIdentity) {
            guard session.isAuthenticated else {
                showingNotificationOnboarding = false
                return
            }
            showingNotificationOnboarding = NotificationOnboardingPolicy.shouldPresent(
                isAuthenticated: session.isAuthenticated,
                isDemo: session.isDemo,
                completed: notificationOnboardingCompleted
            )
            await parcels.start()
        }
        .onChange(of: scenePhase) { _, phase in
            parcels.setActive(phase == .active)
        }
        .onReceive(NotificationCenter.default.publisher(for: .didReceiveAPNSToken)) { notification in
            guard let token = notification.object as? String else { return }
            Task {
                await parcels.forwardNativePushToken(token, language: localizer.language)
            }
        }
        .onChange(of: localizer.language) { _, language in
            guard let token = AppDelegate.currentDeviceToken else { return }
            Task { await parcels.forwardNativePushToken(token, language: language) }
        }
        .fullScreenCover(isPresented: $showingNotificationOnboarding) {
            NotificationOnboardingView {
                notificationOnboardingCompleted = true
                showingNotificationOnboarding = false
            }
            .environmentObject(parcels)
            .environmentObject(localizer)
            .interactiveDismissDisabled()
        }
    }

    private var sessionIdentity: String {
        switch session.state {
        case .loading: "loading"
        case .welcome: "welcome"
        case .demo: "demo"
        case .unconfigured: "unconfigured"
        case .signedOut: "signed-out"
        case .signedIn(let user): user.id.uuidString
        }
    }
}

private struct LaunchView: View {
    @EnvironmentObject private var localizer: Localizer

    var body: some View {
        ZStack {
            Brand.background.ignoresSafeArea()
            VStack(spacing: 20) {
                ParcelGlyph(size: 78)
                ProgressView()
                    .controlSize(.large)
                    .tint(Brand.ink)
                Text(localizer.text("auth.loading"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
