# Architecture

Swiss Delivery Tracker is a React PWA served by a small Python HTTP service.
Supabase Auth identifies users, Postgres row-level security (RLS) isolates their
parcels, and only the background tracker holds a service-role key.

```text
                         email OTP
Browser/PWA <------------------------------> Supabase Auth
    |
    | Bearer access token
    v
Python API -------- user token -----------> PostgREST + Postgres RLS
    |
    +-------- service role ---------------> background tracking writes
    +--------------------------------------> carrier adapters
    +--------------------------------------> Web Push endpoints
```

## Components

- `src/auth/` configures the browser's persisted, auto-refreshing Supabase
  session. `src/store/` talks only to the same-origin application API.
- `server/app.py` serves static assets, authenticates private API routes, applies
  per-account rate limits, and implements the OpenAPI contract.
- `server/supabase_auth.py` validates bearer tokens with Supabase Auth and
  creates a PostgREST client carrying that user's JWT.
- `server/tracking_sync.py` schedules and deduplicates carrier checks. It is the
  only workflow that needs cross-account database access.
- `server/push.py` delivers notifications only to subscriptions owned by the
  package's account.
- `supabase/migrations/` is the append-only database history;
  `supabase/tests/assertions.sql` exercises the RLS boundary in PostgreSQL.
- `contracts/openapi.json` generates the frontend and backend contract enums.

## Trust boundaries

- The Supabase URL and publishable key are intentionally public. The Supabase
  service-role key and VAPID private key are server-only secrets.
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
- Cloudflare may provide TLS, proxying, and abuse protection, but Cloudflare
  Access is not part of the public application's identity model.

## Data lifecycle

Adding a parcel writes an account-owned package through the user's RLS-scoped
client. Carrier events are written by the background worker and inherit privacy
through their package. Archiving retains the parcel and history. Account
deletion removes the Supabase Auth user; foreign-key cascades remove packages,
events, push subscriptions, and delivery acknowledgements.

Rows left by the former shared deployment intentionally remain ownerless and
invisible until an operator completes the explicit cutover in
[DEPLOYMENT.md](DEPLOYMENT.md). New ownerless rows are rejected by database
constraints.
