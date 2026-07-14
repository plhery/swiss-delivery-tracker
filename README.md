# Swiss Delivery Tracker

A friendly, iPhone-first progressive web app to follow your package
deliveries through every stage of their journey — announced, posted,
in transit, out for delivery, delivered — with exceptions like customs
holds, missed deliveries and pickup notices along the way.

Built with **React + Vite + TypeScript**, backed by **Supabase**
(Postgres, Auth, row-level security, realtime), and installable on an
iPhone home screen as a PWA. A small Python service serves the built app
and polls carriers in the background.

## Features

- 🚚 **Stage timeline** — every parcel shows its full journey, newest
  update first, with a 5-step progress track on each card.
- 🇨🇭 **Swiss-first carrier support** — automatic adapters for Swiss
  Post, Quickpac, Planzer, Cainiao/AliExpress, SunYou, Hermes, Spring GDS
  and PostLogistics; carrier links for DHL, UPS, FedEx and DPD.
- 🔄 **Real server-side synchronization** — a scheduled worker checks active
  parcels every 15 minutes, while the refresh button requests an immediate
  authenticated check. Sync time and carrier failures are visible in the UI.
- ☁️ **Durable Supabase storage** — parcels and deduplicated events live in
  Postgres, protected per account through RLS and pushed through realtime.
- 🔐 **Durable accounts** — new users sign in with email and password.
  Existing anonymous sessions can be converted in place, and a one-time
  recovery code can transfer legacy parcels after browser storage was lost.
- 🧪 **Zero-setup demo mode** — without Supabase credentials the app
  runs entirely on-device (localStorage) with a small delivery
  simulation, so you can try it immediately.
- 📱 **iPhone PWA** — standalone display, home-screen icon, safe-area
  aware layout, dark mode, offline shell via a service worker.

## Getting started

```bash
npm install
npm run dev
```

Open the printed URL — with no configuration you'll be in demo mode.

### Connect Supabase for development

1. Create a project at [supabase.com](https://supabase.com).
2. Apply both files in `supabase/migrations/` in filename order (or run
   `supabase db push` with the CLI).
3. Enable email/password sign-up. Anonymous sign-ins are only needed while
   migrating installations that already created anonymous users.
4. Copy `.env.example` to `.env` and fill in your project URL and anon
   key from **Project Settings → API**.
5. Restart `npm run dev` — the demo banner disappears and your parcels
   now sync through Supabase.

With Vite alone, the UI and database work but automatic polling does not.
Run the production container to include the carrier worker:

```bash
docker build \
  --build-arg VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
  --build-arg VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" \
  -t swiss-delivery-tracker .

docker run --rm -p 3000:3000 --env-file .env swiss-delivery-tracker
```

`SUPABASE_SERVICE_ROLE_KEY` is server-only and must never use the `VITE_`
prefix. The `/api/sync` endpoint validates the caller's Supabase access token
and only polls that user's parcels. The scheduled worker uses the service
role to poll all non-completed parcels.

## Carrier engine

The worker installs
[`blue-plhery-assistant/swiss-delivery-tracker`](https://github.com/blue-plhery-assistant/swiss-delivery-tracker)
at pinned commit `62ae24f5677b3ff2d1af5d08574dc544c365a14d`. This keeps its carrier
adapters reusable while this repository owns the web UI, persistence,
scheduling, authentication and deployment behavior.

Carrier adapters scrape public tracking pages and can temporarily fail when
a carrier changes its site or enters maintenance. Those failures are kept on
the parcel as diagnostics and retried; they do not delete the parcel. For a
long-term Swiss Post integration, use its authenticated business tracking API
and replace the scraper adapter.

Email/password sign-up can be auto-confirmed on a private deployment. Configure
SMTP before offering password-reset emails or exposing sign-up beyond a trusted
access layer.

### Install on your iPhone

1. Deploy the app over HTTPS (`npm run build`, then host `dist/` — e.g.
   Vercel, Netlify, or Cloudflare Pages) and open it in Safari.
2. Tap **Share → Add to Home Screen**.
3. Launch it from the icon — it runs full-screen like a native app.

## Testing

```bash
npm test
```

Vitest covers carrier detection, stage/progress logic, authentication, date
formatting, the demo simulation, the Supabase repository and full UI flows.
Python unit tests cover event mapping, deduplication, unsupported carriers and
failure isolation.

```bash
python3 -m unittest discover -s server/tests -v
```

## Project layout

```
src/
  auth/       durable login and legacy-account recovery UI
  lib/        carriers, stages, formatting, supabase client
  store/      data layer: Supabase repo, local demo repo, React context
  components/ cards, timeline, bottom sheet, progress track, detail view
server/       static web server, scheduler and pinned carrier adapter
supabase/
  migrations/ Postgres schema + RLS policies + realtime publication
scripts/      PWA icon generation from the SVG source
```

## Production operations

- Deploy the included `Dockerfile` with port `3000` and health check `/health`.
- Supply both browser build arguments and the three server-side Supabase
  variables from `.env.example`.
- Back up the Postgres service independently of the application container and
  test restoration periodically.
- The service only mutates `sync_*`, carrier metadata and tracking events;
  carrier failures never remove package rows.
