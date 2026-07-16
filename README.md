# Parcel Post

An iPhone-first PWA for following parcels from first lookup to delivery, with
special handling for customs, failed attempts and pickup notices.

The production app uses one deliberately simple security model:

1. Cloudflare Access authenticates the only allowed user at the tunnel.
2. The browser calls the same-origin Python API; it never connects to Supabase.
3. The Python service uses a server-only Supabase service role to manage one
   shared parcel collection.

There is no second login, anonymous browser identity, Protect flow or recovery
code. Every device admitted by Cloudflare Access sees the same packages.

## Features

- **Shared delivery box** — packages live in Postgres and appear on every
  authorized device. Open tabs poll for changes and refresh when they become
  visible again.
- **Server-side synchronization** — a worker checks active parcels every 10
  minutes from 08:00 through 22:00 Europe/Zurich and hourly overnight. The
  refresh button triggers an immediate shared sync.
- **Per-device notifications** — standards-based Web Push alerts each opted-in
  device about newly discovered tracking events. Delivery acknowledgements are
  stored per device, transient failures retry, and expired endpoints are
  disabled automatically.
- **Swiss-first carrier support** — automatic adapters for Swiss Post,
  Quickpac, Planzer, Cainiao/AliExpress, SunYou, Hermes, Spring GDS and
  PostLogistics and DPD; carrier links for DHL, UPS and FedEx.
- **Durable history** — provider events are deduplicated and carrier failures
  remain visible without deleting the parcel.
- **Installable PWA** — standalone home-screen display, safe-area layout and an
  automatically updating offline shell. An open app reloads as soon as an
  installed update takes control.
- **Phone-native navigation** — parcel details can be dismissed with the back
  button or a deliberate swipe to the left without interfering with vertical
  timeline scrolling.
- **Local demo mode** — Vite development uses local sample data unless
  `VITE_USE_API=true` is set.

## Development

```bash
npm install
npm run dev
```

The Vite development server starts in demo mode. To exercise the real API,
build and run the production container with a Supabase database:

```bash
docker build -t swiss-delivery-tracker .
docker run --rm -p 3000:3000 \
  -e SUPABASE_URL=https://supabase.example.com \
  -e SUPABASE_SERVICE_ROLE_KEY=server-only-key \
  -e VAPID_PUBLIC_KEY=base64url-public-key \
  -e VAPID_PRIVATE_KEY=base64url-private-key \
  -e VAPID_SUBJECT=https://delivery.example.com \
  swiss-delivery-tracker
```

Apply every file in `supabase/migrations/` in filename order before running the
container. `SUPABASE_SERVICE_ROLE_KEY` must remain server-only; there are no
`VITE_SUPABASE_*` build variables.

The backend endpoints are:

- `GET /api/packages`
- `POST /api/packages`
- `DELETE /api/packages/:id`
- `POST /api/sync`
- `GET /api/push/config`
- `POST /api/push/subscriptions`
- `DELETE /api/push/subscriptions`
- `GET /health`

They intentionally rely on the deployment's Cloudflare Access boundary. Do not
expose the application origin directly to the public internet.

On iPhone, install Parcel Post with Safari's **Add to Home Screen**, open the
installed app and enable notifications from the bell. Each device opts in
independently, while all devices continue to share the same parcel collection.
Notification text contains the parcel label and progress but never the tracking
number. A notification opens the matching parcel in the app.

## Carrier engine

The production image installs
[`blue-plhery-assistant/swiss-delivery-tracker`](https://github.com/blue-plhery-assistant/swiss-delivery-tracker)
at pinned commit `62ae24f5677b3ff2d1af5d08574dc544c365a14d`. This repository owns the UI,
persistence, API, scheduling and deployment boundary; the upstream project owns
the reusable carrier adapters.

Carrier sites can temporarily return maintenance pages or change markup. Those
failures are stored on the package and retried. A long-term Swiss Post setup
should replace scraping with its authenticated business tracking API.

Planzer shared shipments with numbers shaped like `999.90.########` use a
different tracking site. The add sheet asks for the complete
`trackandtrace.planzergroup.com/shared/sendungen/...` URL, validates that its
shipment number matches and stores the capability link so scheduled syncs can
send its `accessKey`. Ordinary Planzer numbers continue to use the direct API.

DPD protects its public tracking page with a Cloudflare browser challenge.
Automatic DPD tracking therefore requires a private
[`FlareSolverr`](https://github.com/FlareSolverr/FlareSolverr) instance and the
runtime environment variable `FLARESOLVERR_URL`, for example
`http://flaresolverr:8191`. The carrier link remains usable without it.

## Testing

```bash
npm ci
npm run test:coverage
npm run build
npm run test:pwa

python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m coverage run -m unittest discover -s server/tests -v
.venv/bin/python -m coverage report
```

Vitest enforces 85% statement/function/line coverage and 80% branch coverage.
Python coverage is branch-aware and fails below 85%.

Database migrations, service-role CRUD, browser-role denial, constraints and
event deduplication are tested against PostgreSQL 16:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/delivery_test \
  scripts/test-migrations.sh
```

GitHub Actions runs frontend tests on Node 22 and 24, Python tests, migration
assertions, npm audit, PWA validation and a production-container smoke test.

## Project layout

```text
src/
  lib/        carrier, stage and formatting helpers
  store/      shared API repo, local demo repo and React context
  components/ cards, timeline, add sheet, progress and detail views
server/       shared HTTP API, static server, scheduler and carrier adapter
supabase/
  migrations/ Postgres schema and shared-backend transition
  tests/      PostgreSQL integration and security assertions
scripts/      migrations, origin smoke checks and PWA validation
```

## Production operations

- Deploy the Dockerfile on port `3000` with `/health` as the health check.
- Supply `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, the VAPID key pair and a
  valid HTTPS or `mailto:` VAPID subject to the server. VAPID keys must remain
  stable across deployments or existing device subscriptions stop working.
- Keep the hostname behind Cloudflare Access and require Access validation in
  the tunnel ingress rule.
- Back up Postgres independently and verify the reverse-proxy route after every
  deploy with `scripts/smoke-url.sh`.
- The manual `Production origin smoke` workflow supports Cloudflare Access
  service-token secrets and requests a unique path so a service worker cannot
  hide an origin failure.
