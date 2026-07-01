# 📦 Swiss Delivery Tracker

A friendly, iPhone-first progressive web app to follow your package
deliveries through every stage of their journey — announced, posted,
in transit, out for delivery, delivered — with exceptions like customs
holds, missed deliveries and pickup notices along the way.

Built with **React + Vite + TypeScript**, backed by **Supabase**
(Postgres, anonymous auth, row-level security, realtime), and installable
on your iPhone home screen as a PWA.

## Features

- 🚚 **Stage timeline** — every parcel shows its full journey, newest
  update first, with a 5-step progress track on each card.
- 🇨🇭 **Swiss-first carrier detection** — Swiss Post barcodes
  (`99.34.123456.12345678`), registered mail (`RA…CH`), plus DHL, UPS,
  FedEx, DPD and international post, detected from the tracking number
  shape. One tap opens the carrier's own tracking page.
- ☁️ **Supabase sync** — parcels and tracking events live in Postgres,
  scoped to you via anonymous auth + RLS, with realtime updates pushed
  to the app.
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

### Connect Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Apply the schema: paste `supabase/migrations/20260701000000_init.sql`
   into the SQL editor (or run `supabase db push` with the CLI).
3. In **Authentication → Sign In / Up**, enable **Anonymous sign-ins**.
4. Copy `.env.example` to `.env` and fill in your project URL and anon
   key from **Project Settings → API**.
5. Restart `npm run dev` — the demo banner disappears and your parcels
   now sync through Supabase.

Tracking events are inserted per package (`tracking_events` table); the
app subscribes to realtime changes, so anything that writes events — a
scheduled edge function polling a carrier API, a webhook, or manual
inserts — shows up live in the UI.

### Install on your iPhone

1. Deploy the app over HTTPS (`npm run build`, then host `dist/` — e.g.
   Vercel, Netlify, or Cloudflare Pages) and open it in Safari.
2. Tap **Share → Add to Home Screen**.
3. Launch it from the icon — it runs full-screen like a native app.

## Testing

```bash
npm test
```

53 Vitest tests cover carrier detection, stage/progress logic, date
formatting, the demo simulation, the Supabase repository (against a
stubbed client), and the full UI flows (add, inspect timeline, delete,
refresh) via Testing Library.

## Project layout

```
src/
  lib/        carriers, stages, formatting, supabase client
  store/      data layer: Supabase repo, local demo repo, React context
  components/ cards, timeline, bottom sheet, progress track, detail view
supabase/
  migrations/ Postgres schema + RLS policies + realtime publication
scripts/      PWA icon generation from the SVG source
```
