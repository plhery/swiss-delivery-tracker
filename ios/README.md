# Native iPhone app

`SwissDeliveryTracker.xcodeproj` is a real SwiftUI iPhone application, not a
web view. It targets iOS 18 or newer and adopts Liquid Glass automatically on
iOS 26 while retaining a material-based presentation on iOS 18–25.

## Run the demo

1. Open `SwissDeliveryTracker.xcodeproj` in Xcode 26.
2. Select the `SwissDeliveryTracker` scheme and an iPhone simulator.
3. Run. The checked-in configuration starts in local demo mode and needs no
   account, network, Apple team, or private credentials.

Refreshing advances fictional parcels. Reset the sample data from Account.

## Connect the production service

Copy `Configuration/Local.xcconfig.example` to
`Configuration/Local.xcconfig`, then set the public API origin, Supabase URL,
and Supabase publishable key. The local file is gitignored. Never put a
service-role key, APNs `.p8` key, OAuth secret, or SMTP credential in the app.

The iOS app talks to the same authenticated `/api` contract as the PWA. The
Supabase URL and publishable key are used only for Google OAuth or email OTP;
all parcel mutations still go through the application API and its ownership
checks.

For Google sign-in, add this app’s callback URL to Supabase Auth:

```text
swissdeliverytracker://auth-callback
```

## Signing, sharing, and notifications

Before installing on a physical iPhone:

1. Select your Apple Developer team for the app, Share extension, and Delivery
   Widget extension.
2. Register bundle IDs for `com.plhery.SwissDeliveryTracker` and its
   `.ShareExtension` and `.DeliveryWidget` extensions, or change all three
   target identifiers to your own reverse-DNS names.
3. Create the matching App Group and update `SDT_APP_GROUP_IDENTIFIER` in
   `Shared.xcconfig` if you changed it. Enable that group on the app and both
   extension targets.
4. Enable Push Notifications on the app App ID and keep the Push Notifications
   capability enabled in Xcode.
5. Create an APNs signing key and configure the server’s `APNS_TEAM_ID`,
   `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, and `APNS_BUNDLE_ID`. The bundle ID must
   exactly match the installed app.

The app asks for notification permission only after the user taps Enable. It
requests the current opaque device token from Apple at launch and forwards it
over the authenticated API; it does not persist that token locally. Debug
builds register against APNs sandbox and Release builds use production.

The Delivery Widget shows the next active parcel and prioritizes up to two
out-for-delivery parcels. Its small card and each parcel in its medium card open
the corresponding parcel in the app. The same target supplies a Lock Screen and
Dynamic Island Live Activity for the highest-priority parcel. Account settings
can disable both surfaces, clear their shared parcel snapshot, and end the Live
Activity.

The repository's `scripts/refresh-ios-app.sh` helper can install with a free
Personal Team. Apple does not allow App Groups or push notifications for that
signing mode, so the installed personal build supports the Live Activity but
cannot share parcel data with the Home Screen widget. A paid-team build enables
both.

## Feature parity

| Web capability | Native implementation |
| --- | --- |
| Google OAuth, email OTP, session refresh, sign-out | Authentication Services, native OTP form, Keychain session |
| Paste number, carrier URL, shipping text, or scan a barcode | Native add sheet with the shared carrier parser and camera scanner |
| All 16 carriers and special Planzer, Dachser, DPD, S10, and handoff rules | Catalog generated from `contracts/openapi.json` |
| Authenticated API request/response models | Swift Codable models generated from every OpenAPI schema |
| Search, status/carrier filters, priority/date sorting | Searchable native list, pickers, and sections |
| Refresh all or one parcel and live updates | Pull to refresh, toolbar/detail actions, lightweight sync-job polling |
| Rename, archive/undo, restore, direct permanent delete | Detail menus, swipe action, toast, and a destructive confirmation alert |
| Carrier progress, expected date, history, source links | SwiftUI detail hero, progress track, timeline, external links |
| Global presets, quiet hours, per-parcel mute | Native notification settings and parcel toggle |
| Browser Share Target | iOS Share extension for text and URLs |
| Next-up and out-for-delivery glance surface | Small/medium Home Screen widget plus Lock Screen and Dynamic Island Live Activity |
| Offline snapshot and demo mode | Protected per-account cache and persistent fictional demo |
| Account export, privacy, account deletion | System share sheet, privacy link, destructive account flow |
| English, German, French, Italian | Catalog generated from `src/i18n.tsx` plus native-only copy |

Regenerate contract-backed Swift models and native resources after changing the
OpenAPI contract, carriers, or copy:

```bash
npm run contract:generate
npm run ios:resources
```

## Verification

From `ios/`:

```bash
xcodebuild \
  -project SwissDeliveryTracker.xcodeproj \
  -scheme SwissDeliveryTracker \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Use an available simulator name or identifier with the same command and replace
`build` with `test` to run the Swift unit tests. APNs itself requires a signed
build on a physical device; the simulator and demo mode exercise the surrounding
UI without Apple credentials.
