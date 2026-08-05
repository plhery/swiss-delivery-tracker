# Swiss Delivery Tracker privacy notice

Effective: 5 August 2026

This notice describes the official Swiss Delivery Tracker service. A third
party running a fork controls its own deployment and must publish its own
notice.

## Data the service processes

- Your email address, Supabase user ID, session metadata, authentication
  security events, and basic Google profile data when you choose Google sign-in.
- Parcel labels, tracking numbers, carrier selection, tracking history, status,
  timestamps, optional Planzer shared tracking URL, and the delivery postcode
  supplied for a DPD parcel.
- Web Push subscription endpoints, encryption keys, browser user agent, delivery
  acknowledgements, and notification errors when you enable notifications.
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
selected carrier necessarily receives its tracking number; DPD may also receive
the parcel's supplied postcode for recipient verification, and Planzer receives
the supplied shared-link capability. Web Push endpoints receive encrypted
notifications.

Swiss Delivery Tracker does not sell personal data, serve advertising, or
include third-party behavioral analytics.

## Retention and control

Parcel data remains until you delete the account. Archiving a parcel only hides
it from the active list and retains its history. Disabled push endpoints and
delivery acknowledgements may remain until account deletion or operational
cleanup. Infrastructure backups and security logs may persist for the limited
retention configured by their operator.

Use **Download my data** in the account menu for a machine-readable export. Use
**Delete account** to permanently delete the Auth user and cascade-delete their
parcels, tracking events, push subscriptions, and delivery acknowledgements.
Deletion cannot remove data already sent to a carrier or data a processor must
retain for security or legal obligations.

The browser stores the Supabase session, application preferences, an offline
application shell, and an account-scoped offline parcel snapshot that can include
tracking history and a DPD postcode. Signing out clears account-scoped local
state. Browser or operating-system controls can clear site data and notification
permissions.

## Security and contact

The service uses HTTPS, short-lived access tokens, rotating refresh tokens,
Postgres row-level security, account-scoped rate limits, and server-only secret
keys. No internet service can promise absolute security.

For a privacy or security concern, use GitHub's
[private vulnerability report](https://github.com/plhery/swiss-delivery-tracker/security/advisories/new).
Do not include a real tracking number, sign-in code, access token, or Planzer
shared link in a public issue.
