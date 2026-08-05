# Architecture

Parcel Post is a React PWA served by a small Python HTTP service. The browser
uses only the same-origin application API; carrier access, database credentials,
scheduling, and Web Push delivery remain on the server.

```text
Browser/PWA -> Python API -> Supabase Postgres
                    |       -> Web Push endpoints
                    +------ -> carrier adapters
```

## Components

- `src/` contains the installable React application, local demo repository,
  same-origin API client, offline shell, and per-device notification controls.
- `server/app.py` serves static assets and the versioned HTTP contract.
- `server/tracking_sync.py` schedules and deduplicates carrier checks.
- `server/supabase_client.py` owns persistence calls.
- `supabase/migrations/` is the append-only database history.
- `contracts/openapi.json` generates the frontend and backend contract enums.

## Trust boundaries

- Browser-visible configuration must be safe to publish.
- Supabase service-role and VAPID private keys are server-only.
- Tracking numbers, push endpoints, and Planzer `accessKey` URLs are private
  user data and must not appear in logs or analytics.
- Carrier responses are untrusted, size-bounded input.
- RLS and API ownership checks must both prevent cross-user access.

The hosted single-user deployment currently uses Cloudflare Access. The public
multi-user design replaces that boundary with Supabase Auth JWTs, user-scoped
database requests, and RLS while reserving service-role access for background
workers only.
