# Architecture

Swiss Delivery Tracker is a React PWA served by a small Python HTTP service.
Supabase Auth identifies users, Postgres row-level security (RLS) isolates their
parcels, and only the background tracker holds a service-role key.

```text
                         email OTP
Browser/PWA + native iPhone app <----------> Supabase Auth
              |
              | Bearer access token
              v
Python API -------- user token -----------> PostgREST + Postgres RLS
    |
    +-------- service role ---------------> background tracking writes
    +--------------------------------------> carrier adapters
    +--------------------------------------> Web Push endpoints + APNs
```

## Components

- `src/auth/` configures the browser's persisted, auto-refreshing Supabase
  session. `src/store/` talks only to the same-origin application API.
- `ios/` contains the native SwiftUI app, Share extension, protected offline
  cache, Keychain-backed Auth session, and APNs registration flow.
- `server/app.py` serves static assets, authenticates private API routes, applies
  per-account rate limits, and implements the OpenAPI contract.
- `server/supabase_auth.py` validates bearer tokens with Supabase Auth and
  creates a PostgREST client carrying that user's JWT.
- `server/tracking_sync.py` performs carrier checks. `public.sync_jobs` is the
  durable, deduplicated queue; the Python worker claims jobs with database
  leases so deploys, crashes, and multiple replicas do not lose or double-run
  active work. This is the only workflow that needs cross-account access.
- `server/push.py` delivers Web Push and APNs notifications only to devices
  owned by the package's account.
- `supabase/migrations/` is the append-only database history;
  `supabase/tests/assertions.sql` exercises the RLS boundary in PostgreSQL.
- `contracts/openapi.json` generates the frontend and backend contract types.
  `contracts/fixtures/delivery-api.json` is decoded in TypeScript, Python, and
  Swift tests to catch cross-platform payload drift.

## Trust boundaries

- The Supabase URL and publishable key are intentionally public. The Supabase
  service-role key, VAPID private key, and APNs `.p8` key are server-only secrets.
- Every private API request requires a current Supabase access token. Reads pass
  that token to PostgREST, so RLS remains the final ownership boundary. Package
  mutations use owner-bound database functions that repeat validation, enforce
  account quotas, and cannot target another account.
- The service role bypasses RLS and is restricted to scheduled carrier work,
  push delivery, and account deletion. It never reaches the browser bundle.
- Tracking numbers, labels, carrier history, push endpoints, and Planzer or
  Dachser capability URLs are private user data and must not appear in
  application logs or analytics.
- Carrier responses are untrusted, size-bounded input. The adapters imported
  from the pinned tracker dependency receive a private bounded HTTP wrapper.
  Tracking integrations are best effort and cannot establish user identity.
- The Dachser adapter allowlists normalized shipment state and never stores the
  sender, recipient, address, contact, document URLs, or raw carrier response.
- Browser push endpoints are accepted only for known browser push-service hosts,
  and push delivery never follows redirects.
- Native device tokens are accepted only as bounded hexadecimal opaque values,
  never exposed to database client roles, and forwarded only to Apple's fixed
  production or sandbox APNs hosts over HTTP/2.
- Cloudflare may provide TLS, proxying, and abuse protection, but Cloudflare
  Access is not part of the public application's identity model.
- Forwarded client addresses are trusted only when the direct socket peer is in
  `TRUSTED_PROXY_NETWORKS`. Pre-authentication buckets combine that client
  address with a one-way token hash when available, and authenticated limits
  remain account-scoped.
- HTTP and worker logs contain request/job identifiers, normalized routes,
  status, timing, and exception class only. Query strings, tokens, tracking
  data, carrier payloads, and user identifiers are excluded.

## Data lifecycle

Adding a parcel writes an account-owned package through the user's RLS-scoped
client and queues durable work with the service role. Web and iPhone clients
poll the small owner-checked job resource, then reload the parcel collection
once at completion. Carrier events inherit privacy through their package.
Archiving retains the parcel and history. Account deletion removes the Supabase
Auth user; foreign-key cascades remove packages, jobs, events, browser
subscriptions, native devices, and delivery acknowledgements.

The PWA Web Share Target submits with `POST`. Its service worker places the
bounded draft in a private, one-time Cache Storage entry and redirects using
only a marker, so tracking text never appears in a URL or routine HTTP log.

Rows left by the former shared deployment intentionally remain ownerless and
invisible until an operator completes the explicit cutover in
[DEPLOYMENT.md](DEPLOYMENT.md). New ownerless rows are rejected by database
constraints.
