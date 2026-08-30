# Delivery Tracker privacy notice

Effective: 30 August 2026

This notice describes the official Delivery Tracker service for French
and Swiss parcel tracking. A third party running a fork controls its own
deployment and must publish its own notice.

## Data the service processes

- Your email address, Supabase user ID, session metadata, authentication
  security events, and basic Google profile data when you choose Google sign-in.
- Parcel labels, tracking numbers, carrier selection, tracking history, status,
  timestamps, optional Planzer shared and Dachser Customer Iberia capability
  URLs, the delivery postcode supplied for a DPD Switzerland or Mondial Relay
  parcel, and a Colis Privé combined tracking credential that can contain the
  parcel's delivery postcode.
- Web Push subscription endpoints, encryption keys, browser user agent, native
  iPhone APNs device token, optional device name and locale, a random local
  installation identifier, ActivityKit push-to-start and per-activity update
  tokens, delivery acknowledgements, and delivery errors when you enable the
  corresponding notification or Live Activity setting.
- Technical request data processed by the hosting, reverse-proxy, Auth, and mail
  infrastructure, such as IP address, timestamp, and user agent. The Swiss
  Delivery Tracker application does not intentionally retain access logs or add
  analytics.

## Why and where data is processed

The service uses this data to authenticate you, store your delivery box, fetch
carrier updates, synchronize devices, send requested notifications, prevent
abuse, diagnose failures, and honor export or deletion requests.

Supabase processes authentication and database requests. Google provides social
sign-in, and the configured SMTP provider delivers sign-in codes when email OTP
is enabled. Cloudflare and the container host may process network metadata. A
selected carrier necessarily receives its tracking number or carrier-specific
tracking credential. DPD Switzerland may also receive the parcel's supplied
postcode for recipient verification. Mondial Relay requires the five-digit
recipient postcode to retrieve shipment events. Colis Privé receives a combined
credential made from its 12-character shipment number and the five-digit
delivery postcode. Planzer receives the supplied shared-link capability. Dachser
receives its supplied capability URL; the application discards sender,
recipient, address, contact and document fields from Dachser's response. Browser
push services receive encrypted Web Push messages; Apple processes native
notification and Live Activity payloads through APNs. Those Apple payloads can
contain a parcel label, carrier, status, location, and expected delivery text,
but Delivery Tracker does not put the tracking number in them.

Delivery Tracker does not sell personal data, serve advertising, or
include third-party behavioral analytics.

## Retention and control

Parcel data remains until you delete the account. Archiving a parcel only hides
it from the active list and retains its history. Turning off Live Activities or
signing out removes that installation's ActivityKit tokens; disabled browser
endpoints, ordinary native device registrations, and delivery acknowledgements
may remain until account deletion or operational cleanup. Infrastructure backups
and security logs may persist for the limited retention configured by their
operator.

Use **Download my data** in the account menu for a machine-readable export. Use
**Delete account** to permanently delete the Auth user and cascade-delete their
parcels, tracking events, browser subscriptions, native device registrations,
and delivery acknowledgements.
Deletion cannot remove data already sent to a carrier or data a processor must
retain for security or legal obligations.

The browser stores the Supabase session, application preferences, an offline
application shell, and an account-scoped offline parcel snapshot. The iPhone app
stores its session in Keychain and a protected account-scoped parcel snapshot;
it requests a current APNs token from Apple instead of persisting that token
locally. It stores a random installation identifier and the independent Home
Screen widget and Live Activity preferences on the device. Either snapshot can
include tracking history, a carrier capability URL, a DPD Switzerland or
Mondial Relay postcode, and a Colis Privé combined credential that can contain
the delivery postcode. Signing out clears account-scoped local state and ends
Live Activities. Browser or operating-system controls can clear app data, Live
Activities, and notification permissions.

## Security and contact

The service uses HTTPS, short-lived access tokens, rotating refresh tokens,
Postgres row-level security, account-scoped rate limits, and server-only secret
keys. No internet service can promise absolute security.

For a privacy or security concern, use GitHub's
[private vulnerability report](https://github.com/plhery/swiss-delivery-tracker/security/advisories/new).
Do not include a real tracking number or combined tracking credential, delivery
postcode, sign-in code, access token, Planzer shared link, or Dachser detail
link in a public issue.
