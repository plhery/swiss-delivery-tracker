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
- **Swiss-first carrier support** — automatic tracking for Swiss Post,
  Quickpac, Planzer, Cainiao/AliExpress, SunYou, Hermes, Spring GDS,
  PostLogistics, DPD and UPS, with carrier-link or manual fallbacks for the
  remaining choices.
- **Paste-anything add flow** — paste a tracking number, supported carrier URL,
  or surrounding shipping-email text; the app extracts the number and carrier.
  Complete Planzer shared links also carry their required capability URL.
- **Durable history** — provider events are deduplicated and carrier failures
  remain visible without deleting the parcel. Removed parcels are archived and
  can be restored; delivered parcels are archived automatically after 60 days.
- **Installable PWA** — standalone home-screen display, safe-area layout and an
  automatically updating offline shell. An open app reloads as soon as an
  installed update takes control.
- **Phone-native navigation** — parcel details can be dismissed with the back
  button or the familiar iPhone back gesture from the left edge without
  interfering with vertical timeline scrolling.
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

### Environment variables

Copy `.env.example` as a reference. Production secrets belong in the deployment
environment, never in a `VITE_` variable.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Production | Supabase project URL used only by the Python service. |
| `SUPABASE_SERVICE_ROLE_KEY` | Production | Server-only database key. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Recommended in production | Enables origin-side signature, issuer and application-audience validation for the Cloudflare Access JWT on every `/api/*` request. Configure both or neither. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | For push | Stable Web Push key pair. |
| `VAPID_SUBJECT` | For push | HTTPS URL or `mailto:` contact; defaults to the production Parcel Post URL. |
| `DPD_POSTCODE` | Optional | Four-digit delivery postcode. It unlocks DPD's verified scan history and delivery window when available. |
| `FLARESOLVERR_URL` | Recommended for UPS; DPD fallback | Private TRAWL `/v1` endpoint. UPS calls it only when ordinary HTTP is challenged. The legacy variable name is retained for compatibility. |
| `DPD_FIREBASE_API_KEY` | Advanced override | Overrides the public, app-restricted myDPD client identifier pinned in the adapter; normally leave unset. |
| `PORT` | No | HTTP port, default `3000`. |
| `STATIC_DIR` | No | Built frontend directory, default `/app/dist`. |
| `VITE_USE_API` | Local development only | Set to `true` before a Vite build to use the real same-origin API instead of demo data. |

The backend endpoints are:

- `GET /api/openapi.json`
- `GET /api/packages`
- `POST /api/packages`
- `DELETE /api/packages/:id`
- `POST /api/packages/:id/restore`
- `POST /api/sync`
- `POST /api/packages/:id/sync`
- `GET /api/push/config`
- `POST /api/push/subscriptions`
- `DELETE /api/push/subscriptions`
- `GET /health`

They rely on the deployment's Cloudflare Access boundary. In production, set
`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` as defense in depth so the origin
also rejects API requests without a valid Access application token. Do not
expose the application origin directly to the public internet.

`DELETE /api/packages/:id` is a compatibility-shaped soft delete: it sets
`archived_at` and retains the parcel plus its complete event history.

`contracts/openapi.json` is the source of truth for the HTTP payloads, carrier
IDs, tracking stages and sync states. `npm run contract:generate` updates the
generated TypeScript wire types and Python constants; `npm run test:contract`
fails when either generated file has drifted from the OpenAPI document.

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

### Support matrix

“Automatic” means the scheduled Python worker can refresh the parcel. It does
not mean the carrier exposes a supported public API; several adapters use
undocumented endpoints or page parsing and may need maintenance when a carrier
changes its site.

| Carrier | Mode | Requirements and caveats |
| --- | --- | --- |
| Swiss Post | Automatic | Pinned upstream adapter; a contracted business API is preferable for long-term production use. |
| Quickpac | Automatic | Pinned upstream adapter. |
| Planzer | Automatic | Ordinary numbers use the direct adapter. Shared `999.90.########` shipments require the complete capability URL. |
| AliExpress / Cainiao | Automatic | Pinned upstream adapter. |
| SunYou | Automatic | Pinned upstream adapter. |
| Hermes Einrichtungs-Service | Automatic | Pinned upstream adapter. |
| Spring GDS | Automatic | Pinned upstream adapter. |
| PostLogistics | Automatic | Pinned upstream adapter. |
| DPD Switzerland | Automatic | Uses the myDPD guest-client flow. `DPD_POSTCODE` enables verified details; TRAWL is only the web fallback. |
| UPS | Automatic | Tries direct HTTP and keeps its cookie jar in memory. Private TRAWL is the browser fallback when Akamai challenges the server; no shared Redis is needed. |
| DHL, FedEx, International Post | Carrier link | Stored and opened in the carrier site; no scheduled adapter. |
| Dachser, ShipUp | Manual record | Selectable for organization, but no scheduled adapter or generated carrier link. |

Adding a parcel starts its first carrier lookup immediately in the background.
While that lookup is active, the app shows `Sync in progress` and polls briefly
for the result; settled parcels continue to use the normal low-frequency polling
and scheduled carrier retries.

### Planzer shared links

Planzer shared shipments with numbers shaped like `999.90.########` use a
different tracking site. The add sheet asks for the complete
`trackandtrace.planzergroup.com/shared/sendungen/...` URL, validates that its
shipment number matches and stores the capability link so scheduled syncs can
send its `accessKey`. Ordinary Planzer numbers continue to use the direct API.

### DPD postcode and delivery windows

DPD's unverified response contains only a summary. Set the four-digit delivery
postcode to request the verified response:

```dotenv
DPD_POSTCODE=8000 # replace with the recipient's delivery postcode
```

The verified response adds the complete scan list plus `deliveryDate`,
`deliveryTimeFrom` and `deliveryTimeTo`. Parcel Post displays those as, for
example, `today, 13:30–14:30`. DPD does not calculate a window at every stage,
so a newly handed-over parcel can still have no ETA. If the configured postcode
does not match a parcel, the adapter retries without verification and keeps the
basic status working.

`DPD_POSTCODE` is read only by the Python service and sent only to DPD. Parcel
Post does not send it to the browser, copy it into Supabase/carrier data, or log
it. It is nevertheless recipient verification data, so keep it in the private
deployment environment rather than committing a real value.

The primary DPD path reproduces the anonymous guest flow used by the current
myDPD client, including its rotating credential, and therefore does not need a
Cloudflare solver. It is an undocumented interface and can change. The public
tracking page remains the fallback and is protected by Cloudflare; that fallback
needs TRAWL. DPD's supported commercial
[Shipment API](https://label-print-docs.dpd.ch/fr/shipment-api/tracking) is the
durable alternative for installations with a DPD contract; DPD describes the
customer-facing delivery window in
[myDPD/Predict](https://www.dpd.com/ch/en/mydpd/).

### Cloudflare solver and UPS

Run [`TRAWL`](https://github.com/germondai/trawl) on a private network and set,
for example:

```dotenv
FLARESOLVERR_URL=http://flaresolverr:8191
```

The application appends `/v1` when needed and accepts either a final `200` or
the `302` response used by DPD. Do not expose TRAWL publicly: it controls a real
browser and retains browser sessions. Cloudflare and Turnstile are adaptive, so
TRAWL remains best effort; a challenge that demands interactive proof can still
fail, and a residential proxy may be necessary for a datacenter-hosted browser.

UPS first reproduces the carrier's lightweight web-client flow directly through
the image's HTTP/1.1 `curl` client: it loads the tracking page into an in-memory
cookie jar, reads the XSRF token and calls the structured status endpoint so the
complete scan history is retained. The initial direct attempt is bounded to 20
seconds so an Akamai timeout reaches the browser fallback promptly. The jar has
no application-defined lifetime. It is reused until UPS rejects it; the
application then tries an ordinary page refresh before asking TRAWL for a new
browser session.

When Akamai challenges the direct request, TRAWL executes the page once. Parcel
Post imports the browser's complete UPS cookie jar and matching user agent, then
returns to ordinary HTTP for the structured status calls. This makes TRAWL a
session bootstrapper rather than the transport for every UPS request. Parcel
Post neither connects to nor depends on TRAWL's Redis; TRAWL may still use Redis
internally as part of its own deployment. The in-memory UPS session is naturally
lost when Parcel Post restarts and is bootstrapped again only if direct HTTP is
still challenged. If the structured response is temporarily unavailable,
tracking falls back to the rendered UPS summary page.

## Testing

```bash
npm ci
npm run test:contract
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
