#!/bin/zsh

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
SOURCE_IOS="$PROJECT_ROOT/ios"
SCHEME="SwissDeliveryTracker"
BUNDLE_ID="com.plhery.SwissDeliveryTracker.Personal"
TEAM_ID="${DELIVERY_TRACKER_TEAM_ID:-HGC93X794T}"
DEVICE_NAME="${DELIVERY_TRACKER_DEVICE_NAME:-${SWISS_SCOOTERS_DEVICE_NAME:-iPhone de Paul}}"
TEMP_ROOT="${TMPDIR:-/tmp}"
TEMP_ROOT="${TEMP_ROOT%/}"
CACHE_ROOT="$HOME/Library/Caches/DeliveryTrackerRefresh"
DERIVED_DATA="$CACHE_ROOT/DerivedData"
BUILD_LOG="$CACHE_ROOT/refresh.log"
WORK_DIR="$(mktemp -d "$TEMP_ROOT/delivery-tracker-refresh.XXXXXX")"
PROJECT_COPY="$WORK_DIR/ios"
PROJECT_PATH="$PROJECT_COPY/SwissDeliveryTracker.xcodeproj"
PROFILE_DIR="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
PROFILE_BACKUP_DIR="$WORK_DIR/profiles"
SIGNING_BUILD_SUCCEEDED=0

mkdir -p "$CACHE_ROOT" "$PROFILE_BACKUP_DIR"

notify() {
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'display notification (item 1 of argv) with title "Delivery Tracker"' \
    -e 'end run' \
    "$1" >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -d "$WORK_DIR" && "$WORK_DIR" == "$TEMP_ROOT"/delivery-tracker-refresh.* ]]; then
    /bin/rm -rf -- "$WORK_DIR"
  fi
}

restore_cached_profiles() {
  local profile

  mkdir -p "$PROFILE_DIR"
  for profile in "$PROFILE_BACKUP_DIR"/*.mobileprovision(N) "$PROFILE_BACKUP_DIR"/*.provisionprofile(N); do
    /bin/mv "$profile" "$PROFILE_DIR/"
  done
}

remove_cached_personal_profiles() {
  local profile
  local profile_app_id
  local profile_is_local

  [[ -d "$PROFILE_DIR" ]] || return 0

  for profile in "$PROFILE_DIR"/*.mobileprovision(N) "$PROFILE_DIR"/*.provisionprofile(N); do
    profile_app_id="$(security cms -D -i "$profile" 2>/dev/null | plutil -extract Entitlements.application-identifier raw - 2>/dev/null || true)"
    profile_is_local="$(security cms -D -i "$profile" 2>/dev/null | plutil -extract LocalProvision raw - 2>/dev/null || true)"

    if [[ "$profile_app_id" == *".$BUNDLE_ID"* && "$profile_is_local" == "true" ]]; then
      /bin/mv "$profile" "$PROFILE_BACKUP_DIR/"
    fi
  done
}

prepare_personal_project() {
  local project_file="$PROJECT_PATH/project.pbxproj"

  /usr/bin/python3 - "$project_file" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
replacements = [
    (
        'buildPhases = (E30000000000000000000001, E20000000000000000000001, E40000000000000000000001, E10000000000000000000001, ); buildRules = (); dependencies = (D20000000000000000000001, D20000000000000000000003, );',
        'buildPhases = (E30000000000000000000001, E20000000000000000000001, E40000000000000000000001, E10000000000000000000001, ); buildRules = (); dependencies = (D20000000000000000000003, );',
        1,
    ),
    (
        'A10000000000000000000001 = {CreatedOnToolsVersion = 26.6; SystemCapabilities = {com.apple.ApplicationGroups.iOS = {enabled = 1; }; com.apple.Push = {enabled = 1; }; }; };',
        'A10000000000000000000001 = {CreatedOnToolsVersion = 26.6; };',
        1,
    ),
    (
        'A10000000000000000000004 = {CreatedOnToolsVersion = 26.6; SystemCapabilities = {com.apple.ApplicationGroups.iOS = {enabled = 1; }; }; };',
        'A10000000000000000000004 = {CreatedOnToolsVersion = 26.6; };',
        1,
    ),
    (
        'files = (B10000000000000000000014 /* ShareExtension.appex in Embed App Extensions */, B10000000000000000000022 /* DeliveryWidgetExtension.appex in Embed App Extensions */, );',
        'files = (B10000000000000000000022 /* DeliveryWidgetExtension.appex in Embed App Extensions */, );',
        1,
    ),
    ('APS_ENVIRONMENT = development; ', '', 1),
    ('APS_ENVIRONMENT = production; ', '', 1),
    ('CODE_SIGN_ENTITLEMENTS = SwissDeliveryTracker/SwissDeliveryTracker.entitlements; ', '', 2),
    ('CODE_SIGN_ENTITLEMENTS = DeliveryWidgetExtension/DeliveryWidgetExtension.entitlements; ', '', 2),
    ('PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker;', 'PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker.Personal;', 2),
    ('PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker.DeliveryWidget;', 'PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker.Personal.DeliveryWidget;', 2),
]

for old, new, expected in replacements:
    count = text.count(old)
    if count != expected:
        raise SystemExit(f'Expected {expected} project matches, found {count}: {old[:72]}')
    text = text.replace(old, new, expected)

path.write_text(text)
PY
}

on_exit() {
  local exit_code="$1"

  if (( SIGNING_BUILD_SUCCEEDED == 0 )); then
    restore_cached_profiles
  fi
  cleanup
  if (( exit_code != 0 )); then
    notify "Refresh failed. Unlock and connect the iPhone, then try again."
    print
    print "Delivery Tracker refresh failed. The build log is at:"
    print "  $BUILD_LOG"
  fi
}

trap 'on_exit $?' EXIT

print "Refreshing Delivery Tracker on $DEVICE_NAME…"
print "Keep the iPhone unlocked and connected by USB or reachable over Wi-Fi."
print "This Personal Team build excludes push notifications, App Groups, and the Share Extension."
print "The Lock Screen and Dynamic Island Live Activity remain available."
print
notify "Refresh started. Keep the iPhone unlocked and nearby."

if [[ ! -d "$SOURCE_IOS/SwissDeliveryTracker.xcodeproj" ]]; then
  print -u2 "Xcode project not found under: $SOURCE_IOS"
  exit 1
fi

DEVICE_DETAILS="$(xcrun devicectl device info details --device "$DEVICE_NAME" 2>&1)" || {
  print -u2 "$DEVICE_DETAILS"
  print -u2 "The iPhone is not reachable. Connect it by USB, or place it on the same Wi-Fi as this Mac."
  exit 1
}

DEVICE_UDID="$(print -r -- "$DEVICE_DETAILS" | awk '/udid:/ { print $NF; exit }')"
if [[ -z "$DEVICE_UDID" ]]; then
  print -u2 "Could not determine the iPhone UDID."
  exit 1
fi

print "1/3 Building and renewing the free provisioning profile…"
/usr/bin/ditto "$SOURCE_IOS" "$PROJECT_COPY"
prepare_personal_project
remove_cached_personal_profiles
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "platform=iOS,id=$DEVICE_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -quiet \
  build 2>&1 | tee "$BUILD_LOG"

APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphoneos/SwissDeliveryTracker.app"
if [[ ! -d "$APP_PATH" ]]; then
  print -u2 "The build succeeded but the app bundle was not found at $APP_PATH"
  exit 1
fi

SIGNED_ENTITLEMENTS="$(/usr/bin/codesign -d --entitlements :- "$APP_PATH" 2>/dev/null || true)"
if [[ "$SIGNED_ENTITLEMENTS" == *"aps-environment"* || "$SIGNED_ENTITLEMENTS" == *"application-groups"* ]]; then
  print -u2 "The limited build unexpectedly contains a Personal Team-incompatible entitlement."
  exit 1
fi
if [[ -d "$APP_PATH/PlugIns/ShareExtension.appex" ]]; then
  print -u2 "The limited build unexpectedly contains the Share Extension."
  exit 1
fi
WIDGET_PATH="$APP_PATH/PlugIns/DeliveryWidgetExtension.appex"
if [[ ! -d "$WIDGET_PATH" ]]; then
  print -u2 "The limited build is missing the Live Activity extension."
  exit 1
fi
WIDGET_ENTITLEMENTS="$(/usr/bin/codesign -d --entitlements :- "$WIDGET_PATH" 2>/dev/null || true)"
if [[ "$WIDGET_ENTITLEMENTS" == *"application-groups"* ]]; then
  print -u2 "The limited Live Activity extension unexpectedly contains an App Group entitlement."
  exit 1
fi

EXPIRATION_UTC="$(security cms -D -i "$APP_PATH/embedded.mobileprovision" 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null || true)"
EXPIRATION_LOCAL="$EXPIRATION_UTC"
EXPIRATION_EPOCH=""
if [[ -n "$EXPIRATION_UTC" ]]; then
  EXPIRATION_EPOCH="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$EXPIRATION_UTC" '+%s' 2>/dev/null || true)"
  if [[ -n "$EXPIRATION_EPOCH" ]]; then
    EXPIRATION_LOCAL="$(date -r "$EXPIRATION_EPOCH" '+%A, %d %B %Y at %H:%M')"
  fi
fi

if [[ -z "$EXPIRATION_EPOCH" || "$EXPIRATION_EPOCH" -lt "$(( $(date '+%s') + 6 * 24 * 60 * 60 ))" ]]; then
  print -u2 "Xcode did not produce a fresh seven-day provisioning profile."
  exit 1
fi
SIGNING_BUILD_SUCCEEDED=1

print
print "2/3 Installing over the existing app…"
xcrun devicectl device install app --device "$DEVICE_NAME" "$APP_PATH"

print
print "3/3 Launching the app…"
LAUNCH_NOTE=""
LAUNCH_OUTPUT="$(xcrun devicectl device process launch --device "$DEVICE_NAME" "$BUNDLE_ID" 2>&1)" || {
  print -r -- "$LAUNCH_OUTPUT"
  if [[ "$LAUNCH_OUTPUT" == *"profile has not been explicitly trusted"* ]]; then
    print
    print "The app is installed. On the iPhone, trust the developer profile in:"
    print "Settings → General → VPN & Device Management → Developer App"
    LAUNCH_NOTE="Trust the developer profile in iPhone Settings, then open the app."
  elif [[ "$LAUNCH_OUTPUT" == *"device was not, or could not be, unlocked"* ]]; then
    print
    print "The app is installed. Unlock the iPhone and open it normally."
    LAUNCH_NOTE="Unlock the iPhone and open Delivery Tracker."
  else
    print -u2 "The app was installed but could not be launched automatically."
    exit 1
  fi
}
if [[ -z "$LAUNCH_NOTE" ]]; then
  print -r -- "$LAUNCH_OUTPUT"
fi

print
print "Delivery Tracker refresh complete."
print "The refreshed app is valid until $EXPIRATION_LOCAL."
if [[ -n "$LAUNCH_NOTE" ]]; then
  notify "$LAUNCH_NOTE Valid until $EXPIRATION_LOCAL."
else
  notify "Refresh complete. Valid until $EXPIRATION_LOCAL."
fi
