# Contributing to Delivery Tracker

Thanks for helping improve Delivery Tracker. Keep changes focused,
explain the user problem they solve, and avoid including real shipment data in
code, tests, screenshots, logs, or issues.

## Local setup

1. Install Node 24.
2. Run `nvm use && npm install`.
3. Run `npm run dev` for the self-contained demo application.

Production mode needs a Supabase project and the server-only values documented
in `.env.example`. Never expose a service-role key through a `NEXT_PUBLIC_`
variable.

## Before opening a pull request

Run:

```bash
npm run lint
npm run typecheck
npm run test:scripts
npm run test:contract
npm run test:coverage
npm run test:coverage:server
npm run test:e2e
npm run build
npm run test:pwa
```

Install Chromium once before the first browser run with
`npx playwright install chromium`. The journeys run against the fictional demo
data at desktop and mobile viewport sizes.

Database changes must be append-only migrations with corresponding assertions
in `supabase/tests/assertions.sql`. Keep commits small enough to review on their
own and update the OpenAPI contract before changing generated API types.

## Carrier integrations

Carrier sites and undocumented APIs can change without notice. New adapters
must use bounded timeouts and response sizes, avoid personal-data logging, and
degrade to a carrier link when reliable automatic tracking is unavailable.
Every automatic carrier also needs a public, credential-free `canaryUrl` in the
carrier contract. The daily canary reports only carrier IDs, hostnames and HTTP
statuses; it never sends or logs tracking numbers.

By contributing, you agree that your contribution is licensed under the
repository's Apache License 2.0.
