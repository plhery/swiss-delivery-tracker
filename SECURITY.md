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
migration, and retain row-level-security tests. Carrier integrations are
best-effort and must not be treated as trusted input.
