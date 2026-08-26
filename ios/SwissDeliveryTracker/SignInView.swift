import SwiftUI
import UIKit
import UserNotifications

struct WelcomeView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var localizer: Localizer

    var body: some View {
        ZStack {
            Brand.background.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    HStack {
                        Spacer()
                        languageMenu
                    }
                    .padding(.bottom, 32)

                    AuthenticationIdentity(
                        title: localizer.text("welcome.title"),
                        subtitle: localizer.text("welcome.subtitle")
                    )

                    VStack(spacing: 14) {
                        welcomeFeature("shippingbox.and.arrow.backward.fill", "welcome.feature.track")
                        welcomeFeature("bell.badge.fill", "welcome.feature.alerts")
                        welcomeFeature("lock.shield.fill", "welcome.feature.private")
                    }
                    .padding(.top, 28)

                    VStack(spacing: 12) {
                        Button {
                            session.showSignIn()
                        } label: {
                            Label(localizer.text("welcome.signIn"), systemImage: "person.crop.circle.fill")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .frame(height: 54)
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.roundedRectangle(radius: 17))
                        .tint(Brand.accent)
                        .foregroundStyle(Brand.onAccent)

                        Button {
                            session.enterDemo()
                        } label: {
                            Label(localizer.text("welcome.demo"), systemImage: "sparkles")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .frame(height: 54)
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.roundedRectangle(radius: 17))
                        .tint(Brand.ink)

                        Text(localizer.text("welcome.demoDescription"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 30)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 20)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var languageMenu: some View {
        Menu {
            Picker(localizer.text("language.label"), selection: $localizer.language) {
                ForEach(AppLanguage.allCases) { language in
                    Text(language.nativeName).tag(language)
                }
            }
        } label: {
            Label(localizer.language.nativeName, systemImage: "globe")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(height: 42)
                .glassSurface(in: Capsule())
        }
        .foregroundStyle(Brand.ink)
    }

    private func welcomeFeature(_ symbol: String, _ key: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.headline)
                .foregroundStyle(Brand.ink)
                .frame(width: 38, height: 38)
                .background(Brand.accent.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
            Text(localizer.text(key))
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct SignInView: View {
    enum Step { case methods, code }

    let configured: Bool
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var step: Step = .methods
    @State private var email = ""
    @State private var code = ""
    @State private var emailExpanded = false
    @State private var working = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Brand.background.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    HStack {
                        Button {
                            session.showWelcome()
                        } label: {
                            Label(localizer.text("welcome.back"), systemImage: "chevron.left")
                                .labelStyle(.iconOnly)
                                .frame(width: 42, height: 42)
                                .glassSurface(in: Circle())
                        }
                        .foregroundStyle(Brand.ink)
                        .accessibilityLabel(localizer.text("welcome.back"))
                        Spacer()
                        languageMenu
                    }
                    .padding(.bottom, 32)

                    AuthenticationIdentity(
                        title: localizer.text("auth.title"),
                        subtitle: localizer.text("auth.subtitle")
                    )

                    if !configured {
                        configurationNotice.padding(.top, 28)
                    } else if step == .code {
                        codeForm.padding(.top, 28)
                    } else {
                        methods.padding(.top, 28)
                    }

                    privacyNotice.padding(.top, 28)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 20)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var privacyNotice: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 4) {
                Text(localizer.text("auth.privacy"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Link(localizer.text("auth.readPrivacy"), destination: session.configuration.privacyURL)
                    .font(.caption.weight(.semibold))
                    .tint(Brand.ink)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 18)
        .overlay(alignment: .top) { Divider() }
    }

    private var languageMenu: some View {
        Menu {
            Picker(localizer.text("language.label"), selection: $localizer.language) {
                ForEach(AppLanguage.allCases) { language in
                    Text(language.nativeName).tag(language)
                }
            }
        } label: {
            Label(localizer.language.nativeName, systemImage: "globe")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(height: 42)
                .glassSurface(in: Capsule())
        }
        .foregroundStyle(Brand.ink)
    }

    private var configurationNotice: some View {
        NoticeBanner(
            symbol: "wrench.and.screwdriver.fill",
            title: localizer.text("auth.configTitle"),
            message: localizer.text("native.configurationHelp"),
            tint: .orange
        )
    }

    private var methods: some View {
        VStack(spacing: 12) {
            if session.configuration.googleAuthEnabled {
                Button {
                    run { try await session.signInWithGoogle() }
                } label: {
                    HStack {
                        Text("G").font(.headline.weight(.bold)).foregroundStyle(.blue)
                        Text(working ? localizer.text("auth.googleOpening") : localizer.text("auth.google"))
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 18)
                    .frame(height: 54)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 16))
                .tint(Brand.ink)
                .foregroundStyle(Brand.background)
                .disabled(working)
            }

            if session.configuration.googleAuthEnabled && emailFormVisible {
                HStack {
                    Rectangle().frame(height: 0.5)
                    Text(localizer.text("auth.or")).font(.caption).foregroundStyle(.secondary)
                    Rectangle().frame(height: 0.5)
                }
                .foregroundStyle(.secondary.opacity(0.35))
            }

            if emailFormVisible {
                emailForm
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else if session.configuration.emailOTPEnabled {
                Button {
                    errorMessage = nil
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                        emailExpanded = true
                    }
                } label: {
                    Label(localizer.text("auth.emailOption"), systemImage: "envelope")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.roundedRectangle(radius: 16))
                .tint(Brand.ink)
                .disabled(working)
            }
            if !emailFormVisible {
                errorView
            }
        }
    }

    private var emailFormVisible: Bool {
        session.configuration.emailOTPEnabled
            && (!session.configuration.googleAuthEnabled || emailExpanded)
    }

    private var emailForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(localizer.text("auth.emailIntro"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField(localizer.text("auth.email"), text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 15)
                .frame(height: 52)
                .background(.background, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 15).stroke(.separator.opacity(0.7)))
            errorView
            Button {
                run {
                    try await session.sendCode(to: email.cleanedEmail)
                    step = .code
                }
            } label: {
                HStack {
                    if working { ProgressView().tint(Brand.ink) }
                    Text(working ? localizer.text("auth.sending") : localizer.text("auth.send"))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .tint(Brand.accent)
            .foregroundStyle(Brand.onAccent)
            .disabled(working || !email.cleanedEmail.contains("@"))
        }
        .padding(18)
        .parcelCardSurface()
    }

    private var codeForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(localizer.text("auth.codeIntro", ["email": email.cleanedEmail]))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField(localizer.text("auth.code"), text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .font(.title2.weight(.semibold).monospacedDigit())
                .multilineTextAlignment(.center)
                .onChange(of: code) { _, value in
                    code = String(value.filter(\.isNumber).prefix(6))
                }
                .padding(.horizontal, 15)
                .frame(height: 58)
                .background(.background, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 15).stroke(.separator.opacity(0.7)))
            errorView
            Button {
                run { try await session.verifyCode(email: email.cleanedEmail, code: code) }
            } label: {
                HStack {
                    if working { ProgressView().tint(Brand.ink) }
                    Text(working ? localizer.text("auth.signingIn") : localizer.text("auth.openBox"))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .tint(Brand.accent)
            .foregroundStyle(Brand.onAccent)
            .disabled(working || code.count != 6)

            Button(localizer.text("auth.differentEmail")) {
                step = .methods
                code = ""
                errorMessage = nil
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .disabled(working)
        }
        .padding(20)
        .parcelCardSurface()
    }

    @ViewBuilder private var errorView: some View {
        if let errorMessage {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !working else { return }
        working = true
        errorMessage = nil
        Task {
            do { try await operation() }
            catch { errorMessage = localizer.errorMessage(error) }
            working = false
        }
    }
}

struct NotificationOnboardingView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.scenePhase) private var scenePhase
    let onComplete: () -> Void

    @State private var working = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Brand.background.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    Text(localizer.text("onboarding.notifications.eyebrow"))
                        .font(.caption.weight(.bold))
                        .textCase(.uppercase)
                        .tracking(1.2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    notificationGlyph
                        .padding(.top, 24)

                    Text(localizer.text(store.notificationsEnabledOnDevice
                        ? "onboarding.notifications.enabledTitle"
                        : "onboarding.notifications.title"))
                        .font(.system(.title, design: .rounded, weight: .bold))
                        .multilineTextAlignment(.center)
                        .padding(.top, 22)

                    Text(localizer.text(store.notificationsEnabledOnDevice
                        ? "onboarding.notifications.enabledSubtitle"
                        : "onboarding.notifications.subtitle"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.top, 10)
                        .padding(.horizontal, 8)

                    VStack(spacing: 13) {
                        feature("sun.max.fill", "onboarding.notifications.feature.delivery")
                        feature("shippingbox.fill", "onboarding.notifications.feature.pickup")
                        feature("exclamationmark.triangle.fill", "onboarding.notifications.feature.issues")
                    }
                    .padding(18)
                    .parcelCardSurface()
                    .padding(.top, 24)

                    Text(localizer.text("onboarding.notifications.fineTune"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.top, 18)

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                            .padding(.top, 16)
                    }

                }
                .padding(.horizontal, 24)
                .padding(.vertical, 22)
                .padding(.bottom, 14)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { actionTray }
        }
        .task { await store.refreshNotificationState() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await store.refreshNotificationState() }
        }
    }

    private var notificationGlyph: some View {
        ZStack {
            Circle()
                .fill(Brand.accent.opacity(0.22))
                .frame(width: 110, height: 110)
            Circle()
                .stroke(Brand.accent.opacity(0.34), lineWidth: 1)
                .frame(width: 86, height: 86)
            Image(systemName: store.notificationsEnabledOnDevice ? "bell.badge.fill" : "bell.and.waves.left.and.right.fill")
                .font(.system(size: 38, weight: .semibold))
                .symbolRenderingMode(.palette)
                .foregroundStyle(Brand.ink, Brand.accent)
        }
        .accessibilityHidden(true)
    }

    private var actionTray: some View {
        VStack(spacing: 9) {
            primaryButton
            if !store.notificationsEnabledOnDevice {
                Button(localizer.text("onboarding.notifications.notNow")) {
                    store.deferNotificationOnboarding()
                    onComplete()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minHeight: 34)
                .disabled(working)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 6)
        .background(.regularMaterial)
        .overlay(alignment: .top) { Divider().opacity(0.45) }
    }

    private func feature(_ symbol: String, _ key: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(Brand.ink)
                .frame(width: 40, height: 40)
                .background(Brand.accent.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
            Text(localizer.text(key))
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var primaryButton: some View {
        if store.notificationsEnabledOnDevice {
            Button(action: onComplete) {
                Label(localizer.text("onboarding.notifications.continue"), systemImage: "checkmark")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 17))
            .tint(Brand.accent)
            .foregroundStyle(Brand.onAccent)
        } else if store.notificationStatus == .denied {
            Button {
                UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
            } label: {
                Label(localizer.text("native.openSettings"), systemImage: "gear")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 17))
            .tint(Brand.ink)
        } else {
            Button(action: enableNotifications) {
                HStack(spacing: 9) {
                    if working { ProgressView().tint(Brand.ink) }
                    Image(systemName: working ? "bell" : "bell.badge.fill")
                    Text(localizer.text(working
                        ? "onboarding.notifications.enabling"
                        : "onboarding.notifications.enable"))
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 54)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 17))
            .tint(Brand.accent)
            .foregroundStyle(Brand.onAccent)
            .disabled(working)
        }
    }

    private func enableNotifications() {
        guard !working else { return }
        working = true
        errorMessage = nil
        Task {
            do {
                _ = try await store.enableNotifications(language: localizer.language)
                onComplete()
            } catch {
                await store.refreshNotificationState()
                if store.notificationStatus == .denied {
                    errorMessage = localizer.text("native.notificationsDenied")
                } else if store.notificationStatus == .authorized || store.notificationStatus == .provisional {
                    errorMessage = localizer.text("onboarding.notifications.connectionError")
                } else {
                    errorMessage = localizer.errorMessage(error)
                }
            }
            working = false
        }
    }
}

private extension String {
    var cleanedEmail: String {
        trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

private struct AuthenticationIdentity: View {
    let title: String
    let subtitle: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ParcelGlyph(size: 54)
            VStack(alignment: .leading, spacing: 5) {
                Text("Swiss Delivery Tracker")
                    .font(.subheadline.weight(.bold))
                Text(title)
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
