# Public deployment runbook

This runbook makes the application publicly reachable while retaining
Cloudflare as the TLS/reverse-proxy layer and replacing Cloudflare Access with
Supabase Auth.

## 1. Prepare the dependencies

- A Supabase stack with Auth, PostgREST, and PostgreSQL 16 or newer.
- A transactional SMTP service and authenticated sending domain.
- A container host capable of building the repository Dockerfile.
- A public HTTPS hostname. The official deployment uses
  `https://delivery.plhery.com`.
- Stable VAPID keys if Web Push is enabled.
- An Apple App ID, APNs key, and signing team if native iPhone notifications or
  server-driven Live Activities are enabled.
- Database backups and a tested restore path.

Review [AUTHENTICATION.md](AUTHENTICATION.md) before configuring Auth. Never put
the service-role, VAPID private, SMTP, carrier, or Cloudflare credentials in a
frontend build argument.

## 2. Back up and migrate the database

Take a fresh database backup. Apply every `supabase/migrations/*.sql` file in
filename order and stop on the first error. The migration CI job applies the
complete history to a clean PostgreSQL 16 database and runs RLS assertions.

For an existing private/shared deployment, the migrations preserve old parcels
with `user_id IS NULL`. Those rows are invisible to every signed-in user. Do not
assign them until the intended owner has successfully signed in once and has an
`auth.users` record.

Preflight the cutover with a service-role SQL session:

```sql
select id, email, created_at from auth.users order by created_at;
select count(*) as ownerless_packages from public.packages where user_id is null;
select count(*) as ownerless_push_subscriptions
from public.push_subscriptions where user_id is null;
```

Replace `OWNER_UUID` below with the verified Auth user ID. Check for a tracking
number conflict before claiming rows:

```sql
select tracking_number, count(*)
from public.packages
where user_id is null or user_id = 'OWNER_UUID'::uuid
group by tracking_number
having count(*) > 1;
```

Resolve any returned duplicate explicitly, then perform the one-way claim:

```sql
begin;

update public.packages
set user_id = 'OWNER_UUID'::uuid
where user_id is null;

-- Old browser endpoints have no trustworthy owner. Users opt in again.
delete from public.push_subscriptions where user_id is null;

alter table public.packages
  validate constraint packages_owner_required_check;
alter table public.packages alter column user_id set not null;

alter table public.push_subscriptions
  validate constraint push_subscriptions_owner_required_check;
alter table public.push_subscriptions alter column user_id set not null;

commit;
```

Verify zero ownerless rows remain and take another backup. If this is a new
deployment, the validation and `NOT NULL` steps can be performed immediately.

## 3. Configure Auth and email

1. Set the Auth Site URL to the public HTTPS origin and restrict redirect URLs.
2. Enable email OTP sign-ups and put `{{ .Token }}` in the OTP template.
3. Configure Google OAuth, custom SMTP, or both. Disable the matching frontend
   method when its provider is not production-ready.
4. For email OTP, configure sender identity, SPF, DKIM, DMARC, CAPTCHA, and
   appropriate Auth email rate limits.
5. For Google, configure the exact Supabase callback URI and keep the OAuth
   client secret only in the Auth service.
6. Leave session time-box and inactivity limits disabled for persistent login,
   or set both to at least 30 days.

## 4. Build and deploy

The two browser values are build-time arguments:

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://supabase.example.com \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_example \
  -t swiss-delivery-tracker .
```

The production Docker build validates these values, requires API mode, and
requires at least one enabled authentication method. It fails before running
`next build` rather than producing an unusable sign-in screen.

Set the matching server variables plus `SUPABASE_SERVICE_ROLE_KEY` at runtime.
Add the stable VAPID key pair and `VAPID_SUBJECT` only when browser push is
enabled. For native push, set `APNS_TEAM_ID`, `APNS_KEY_ID`, the complete
`APNS_PRIVATE_KEY` `.p8` value, and `APNS_BUNDLE_ID`; partial VAPID or APNs
configuration is rejected at startup. See `.env.example` for the complete inventory.
The same APNs key sends ordinary alerts and ActivityKit pushes; the app bundle
ID is used directly for alerts and with Apple's `.push-type.liveactivity` topic
suffix for Live Activities.

This application includes a durable in-process scheduler, so run the standalone
Next.js server as a continuously running container or process. A request-only
serverless runtime will not keep the carrier worker alive.

Set `TRUST_PROXY_HEADERS=true` only when a trusted reverse proxy connects to the
container and overwrites `CF-Connecting-IP`, `X-Real-IP`, and
`X-Forwarded-For`. Leave it false when clients can reach the origin directly.

Expose container port `3000`, use `GET /health` as the health check, and keep the
container behind HTTPS. The public health response intentionally contains only
`{"ok": true}`. Authenticated API responses use `Cache-Control: no-store`.

## 5. Cut over without exposing private data

1. Keep Cloudflare Access enabled while deploying the new image.
2. Sign in through the new OTP screen and verify the intended Auth user ID.
3. Claim legacy parcels using step 2 and confirm they appear only for that user.
4. Test with a second disposable account and verify cross-account isolation.
5. Exercise add, sync, archive, restore, browser and native push opt-in, export,
   sign-out, and account deletion. Separately enable Live Activities, move a
   disposable parcel to out for delivery, verify it starts while the app is
   closed without a duplicate ordinary banner, and verify its terminal state
   dismisses after the grace period. Confirm API rate limits return `429` and
   `Retry-After` when exceeded.
6. Remove the Cloudflare Access application/policy for the app hostname, but
   retain Cloudflare proxying, TLS, WAF, and origin restrictions as desired.
7. Run `scripts/smoke-url.sh https://your-hostname` from outside the origin.
8. Make the GitHub repository public only after the live app is protected by
   Supabase Auth and the repository/history scan contains no private secrets.

The manual `Production origin smoke` workflow accepts optional Cloudflare Access
service-token secrets for private or transitional deployments. Remove those
repository secrets when they are no longer used.

## 6. Operate and recover

- Configure the dedicated Sentry project with `SENTRY_DSN`,
  `SENTRY_ENVIRONMENT=production`, zero tracing unless deliberately changed,
  and an immutable release. Keep new-issue, regression, and Cron monitor
  notifications enabled. See [OBSERVABILITY.md](OBSERVABILITY.md).
- Monitor `401`, `429`, database gateway failures, carrier failures, suspicious
  classifications, missed scheduled checks, SMTP bounces, and push disablement
  without logging tracking numbers or tokens.
- Application logs are one-line JSON. Alert on `sync_claim_failed`,
  `sync_job_failed`, and `sync_job_finish_failed`; use `request_id` and `job_id`
  for correlation without adding user or parcel data to logs.
- The API allows 12 sync requests per account per five minutes, 240 reads per
  minute, and 60 other writes per minute. Edge and Auth-level abuse controls are
  still required for unauthenticated OTP traffic.
- Database functions cap each account at 50 active and 500 total parcels, and a
  scheduled synchronization processes at most five parcels per account in
  round-robin order. Treat changes to these limits as security-sensitive.
- Next.js handles request admission. Application pre-authentication limits
  combine a trusted forwarded address with a hashed bearer credential when
  supplied; authenticated limits are per account. Keep the origin behind an
  edge rate limiter as an independent layer.
- Carrier refreshes live in `public.sync_jobs`. Running jobs use leases and can
  be reclaimed after a worker crash; active package and scheduled jobs are
  deduplicated, and terminal job records are retained for 30 days. Back up this
  table with the rest of Postgres.
- Every refresh writes a service-role-only attempt and step trace. Start with
  `tracking_sync_health_24h`, then follow a Sentry `attempt_id` into
  `tracking_sync_attempts` and `tracking_sync_steps`. Completed traces remain
  for 90 days; hard-crashed attempts are marked abandoned after 30 minutes.
- Back up Postgres independently. Regularly test restoring Auth, parcel, event,
  and push tables together.
- Rotate service-role, SMTP, VAPID, APNs, and carrier credentials if exposed.
  Rotating VAPID keys invalidates existing browser subscriptions; revoke an
  exposed APNs key in the Apple Developer portal before replacing it.
- If auth or ownership verification fails during cutover, re-enable Cloudflare
  Access immediately. Do not undo ownership by setting `user_id` back to null.
