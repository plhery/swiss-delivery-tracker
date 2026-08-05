# Contributing to Swiss Delivery Tracker

Thanks for helping improve Swiss Delivery Tracker. Keep changes focused,
explain the user problem they solve, and avoid including real shipment data in
code, tests, screenshots, logs, or issues.

## Local setup

1. Install Node 24 and Python 3.13.
2. Run `nvm use && npm install`.
3. Create a virtual environment and run
   `python -m pip install --require-hashes -r requirements-dev.lock`.
4. Run `npm run dev` for the self-contained demo application.

Production mode needs a Supabase project and the server-only values documented
in `.env.example`. Never expose a service-role key through a `VITE_` variable.

## Before opening a pull request

Run:

```bash
npm run lint:frontend
npm run test:contract
npm run test:coverage
npm run build
npm run test:pwa
python -m ruff check server
python -m mypy server
python -m coverage run -m unittest discover -s server/tests -v
python -m coverage report
```

Database changes must be append-only migrations with corresponding assertions
in `supabase/tests/assertions.sql`. Keep commits small enough to review on their
own and update the OpenAPI contract before changing generated API types.
After changing Python requirements, regenerate both hashed lock files with
`uv pip compile --universal --generate-hashes` before running CI.

## Carrier integrations

Carrier sites and undocumented APIs can change without notice. New adapters
must use bounded timeouts and response sizes, avoid personal-data logging, and
degrade to a carrier link when reliable automatic tracking is unavailable.

By contributing, you agree that your contribution is licensed under the
repository's Apache License 2.0.
