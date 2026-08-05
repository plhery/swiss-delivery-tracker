# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue for authentication bypasses, cross-user data exposure,
secret leakage, unsafe carrier responses, or push-notification privacy issues.

Include a concise reproduction, affected revision, and impact. Do not include
real tracking numbers, Planzer capability links, Supabase keys, VAPID keys,
Cloudflare service tokens, push endpoints, or other users' data.

## Supported versions

Security fixes are made against the latest revision of `main`. This project is
currently pre-1.0 and does not maintain security backports for older commits or
self-hosted forks.

## Deployment boundary

The Supabase service-role and VAPID private keys are server-only. A deployment
must use HTTPS, keep authenticated responses uncached, apply every database
migration, configure production SMTP and Auth abuse controls, and retain
row-level-security tests. Private API routes require a validated Supabase token,
account ownership is enforced again by Postgres RLS, and new ownerless records
are rejected. Carrier integrations are best-effort and must not be treated as
trusted input.

Operators must complete the ownership cutover in `docs/DEPLOYMENT.md` before
removing an existing edge-authentication layer. Keep the database, service-role
key, SMTP credentials, VAPID private key, carrier secrets, and origin ports
unreachable from the public internet except through their intended interfaces.
