import SwiftUI
import UIKit

struct NotificationSettingsView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @State private var draft = NotificationPreferencesDraft()
    @State private var working = false
    @State private var notice: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(alignment: .top, spacing: 13) {
                        Image(systemName: store.notificationsEnabledOnDevice ? "bell.badge.fill" : "bell")
                            .font(.title2)
                            .foregroundStyle(store.notificationsEnabledOnDevice ? Brand.accent : .secondary)
                            .frame(width: 42, height: 42)
                            .background(.secondary.opacity(0.09), in: Circle())
                        VStack(alignment: .leading, spacing: 4) {
                            Text(localizer.text(store.notificationsEnabledOnDevice
                                ? "notifications.enabledTitle" : "notifications.disabledTitle"))
                                .font(.headline)
                            Text(systemStatusText)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 5)

                    if store.notificationStatus == .denied {
                        Button(localizer.text("native.openSettings"), systemImage: "gear") {
                            UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
                        }
                    } else if store.notificationsEnabledOnDevice {
                        Button(localizer.text("notifications.disable"), role: .destructive) {
                            run {
                                try await store.disableNotifications()
                                notice = nil
                            }
                        }
                    } else {
                        Button {
                            run {
                                let welcomeSent = try await store.enableNotifications(language: localizer.language)
                                if !welcomeSent { notice = localizer.text("notifications.error.welcome") }
                            }
                        } label: {
                            Label(
                                working ? localizer.text("notifications.enabling") : localizer.text("notifications.enable"),
                                systemImage: "bell.badge"
                            )
                        }
                    }
                } footer: {
                    Text(localizer.text("notifications.schedule"))
                }

                if store.notificationPreferences != nil {
                    Section(localizer.text("notifications.preferencesTitle")) {
                        ForEach(NotificationPreset.allCases) { option in
                            Button {
                                draft.preset = option
                            } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: draft.preset == option ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(draft.preset == option ? Brand.accent : .secondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(localizer.text(option.titleKey)).foregroundStyle(.primary)
                                        Text(localizer.text(option.descriptionKey))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    Section {
                        Toggle(localizer.text("notifications.quietHours"), isOn: $draft.quietHoursEnabled)
                        if draft.quietHoursEnabled {
                            DatePicker(
                                localizer.text("notifications.from"),
                                selection: $draft.quietStart,
                                displayedComponents: .hourAndMinute
                            )
                            DatePicker(
                                localizer.text("notifications.until"),
                                selection: $draft.quietEnd,
                                displayedComponents: .hourAndMinute
                            )
                        }
                    } footer: {
                        Text(localizer.text("notifications.quietDescription"))
                    }

                    Section {
                        Button {
                            savePreferences()
                        } label: {
                            HStack {
                                if working { ProgressView() }
                                Text(working ? localizer.text("notifications.saving") : localizer.text("notifications.save"))
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .disabled(working)
                    }
                }

                if let notice {
                    Section {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .font(.subheadline).foregroundStyle(.green)
                    }
                }
                if let errorMessage = errorMessage ?? store.notificationError {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(localizer.text("notifications.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(localizer.text("common.close")) { dismiss() }.fontWeight(.semibold)
                }
            }
            .task {
                await store.refreshNotificationState()
                await store.loadNotificationPreferences()
                hydrate()
            }
            .onChange(of: store.notificationPreferences) { _, _ in hydrate() }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var systemStatusText: String {
        if store.notificationsEnabledOnDevice { return localizer.text("notifications.state.enabled") }
        switch store.notificationStatus {
        case .denied: return localizer.text("notifications.state.blocked")
        case .authorized, .provisional, .ephemeral: return localizer.text("notifications.state.prompt")
        case .notDetermined: return localizer.text("notifications.state.prompt")
        @unknown default: return localizer.text("notifications.state.checking")
        }
    }

    private func hydrate() {
        guard let preferences = store.notificationPreferences else { return }
        draft = NotificationPreferencesDraft(preferences: preferences)
    }

    private func savePreferences() {
        let value = draft.preferences(timezone: TimeZone.current.identifier)
        run {
            try await store.saveNotificationPreferences(value)
            notice = localizer.text("notifications.saved")
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

struct AccountView: View {
    @EnvironmentObject private var store: ParcelStore
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    @State private var exportURL: URL?
    @State private var showingShareSheet = false
    @State private var confirmingDeletion = false
    @State private var confirmation = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Text(accountInitial)
                            .font(.title2.weight(.bold))
                            .frame(width: 48, height: 48)
                            .background(Brand.accent.opacity(0.25), in: Circle())
                        VStack(alignment: .leading, spacing: 3) {
                            Text(localizer.text(store.isDemo ? "welcome.demo" : "account.signedIn"))
                                .font(.caption).foregroundStyle(.secondary)
                            Text(session.user?.email ?? localizer.text("app.demo"))
                                .font(.headline).textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section(localizer.text("language.label")) {
                    Picker(localizer.text("language.label"), selection: $localizer.language) {
                        ForEach(AppLanguage.allCases) { language in
                            Text(language.nativeName).tag(language)
                        }
                    }
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { store.deliveryWidgetEnabled },
                        set: { store.setDeliveryWidgetEnabled($0) }
                    )) {
                        Label(localizer.text("widget.settingTitle"), systemImage: "rectangle.3.group")
                    }
                } footer: {
                    Text(localizer.text("widget.settingDescription"))
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { store.deliveryLiveActivitiesEnabled },
                        set: { store.setDeliveryLiveActivitiesEnabled($0) }
                    )) {
                        Label(localizer.text("liveActivity.settingTitle"), systemImage: "wave.3.right.circle")
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(localizer.text("liveActivity.settingDescription"))
                        if let error = store.deliveryLiveActivityError {
                            Text(error).foregroundStyle(.red)
                        }
                    }
                }

                Section {
                    Button(localizer.text("account.export"), systemImage: "square.and.arrow.up") {
                        run {
                            exportURL = try await store.exportAccount()
                            showingShareSheet = true
                        }
                    }
                    Link(destination: session.configuration.privacyURL) {
                        Label(localizer.text("account.privacy"), systemImage: "hand.raised")
                    }
                }

                if !store.isDemo {
                    Section {
                        Button(localizer.text("account.signOut"), systemImage: "rectangle.portrait.and.arrow.right") {
                            run {
                                try await store.signOut()
                                dismiss()
                            }
                        }
                    }
                } else {
                    Section {
                        Button(localizer.text("welcome.signInInstead"), systemImage: "person.crop.circle") {
                            session.showSignIn()
                            dismiss()
                        }
                    }
                }

                Section {
                    Button(
                        store.isDemo ? localizer.text("native.resetDemo") : localizer.text("account.delete"),
                        systemImage: "trash",
                        role: .destructive
                    ) {
                        confirmation = ""
                        confirmingDeletion = true
                    }
                } footer: {
                    Text(localizer.text("account.deleteDescription"))
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline).foregroundStyle(.red)
                    }
                }
            }
            .disabled(working)
            .navigationTitle(localizer.text("native.account"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localizer.text("common.close")) { dismiss() }
                }
                if working {
                    ToolbarItem(placement: .topBarTrailing) { ProgressView() }
                }
            }
        }
        .sheet(isPresented: $showingShareSheet) {
            if let exportURL { ActivityShareSheet(items: [exportURL]) }
        }
        .alert(localizer.text("account.deleteQuestion"), isPresented: $confirmingDeletion) {
            if !store.isDemo {
                TextField(
                    localizer.text("account.typeToConfirm", ["email": session.user?.email ?? ""]),
                    text: $confirmation
                )
                .textInputAutocapitalization(.never)
            }
            Button(localizer.text("common.cancel"), role: .cancel) {}
            Button(localizer.text("account.deletePermanent"), role: .destructive) {
                run {
                    try await store.deleteAccount(confirmation: confirmation)
                    dismiss()
                }
            }
            .disabled(!store.isDemo && confirmation.cleaned != (session.user?.email ?? "").cleaned)
        } message: {
            Text(localizer.text("account.deleteDescription"))
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var accountInitial: String {
        String((session.user?.email ?? "D").first ?? "D").uppercased()
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

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private extension String {
    var cleaned: String { trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
}
