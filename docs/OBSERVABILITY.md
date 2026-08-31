# Tracking observability

Delivery Tracker records a carrier refresh in three deliberately separate
places:

1. one-line JSON logs explain the live control flow without parcel data;
2. private Postgres audit rows retain the classification evidence and every
   completed step; and
3. Sentry groups actionable failures and suspicious classifications, using an
   opaque `attempt_id` to link back to Postgres.

This split is a privacy boundary. Tracking numbers, labels, locations, event
descriptions, raw carrier responses, user ids, tokens, cookies, and capability
URLs must never be sent to logs or Sentry.

## What is recorded

`public.tracking_sync_attempts` stores one row per parcel check. It records the
configured and actual carrier, job and package references, previous stage,
provider status, reported and selected stages, event counts, outcome, error
class, and anomaly codes. The bounded `status_text` is private database data;
it exists specifically to explain a mistaken classifier decision and is never
copied to telemetry.

`public.tracking_sync_steps` records `selected`, `fetch`, `normalize`,
`persist_events`, `persist_package`, and `complete` with status and duration.
An expected not-yet-announced or wrong tracking number is a successful `fetch`
whose disposition is `unannounced`; the attempt finishes as `waiting`. A
network, challenge, parser, or storage failure has a failed step and finishes
as `error`.

Completed audit rows are retained for 90 days. A running attempt older than 30
minutes is marked `abandoned`, and that condition is sent to Sentry. Package or
account deletion cascades immediately through its audit history.

Anomalies currently mean:

- `invalid_event_timestamp`: at least one non-empty provider timestamp could
  not be parsed;
- `future_event_timestamp`: a normalized event is more than 24 hours ahead;
- `observed_without_timestamp`: a stage-changing synthetic observation was
  needed (recorded in Postgres, intentionally not alerted by itself);
- `terminal_stage_regression`: a delivered/returned parcel moved to another
  stage;
- `delivered_status_conflict`: provider status says delivered while the chosen
  stage does not; and
- `progress_disappeared`: a parcel with prior progress suddenly has no usable
  provider evidence.

## First-response queries

Run these with the Supabase service role or directly as a database operator.
The tables and views are inaccessible to browser roles.

Carrier health over the last day:

```sql
select *
from public.tracking_sync_health_24h
order by error_percent desc nulls last, attempts desc;
```

Open an alert by its Sentry `attempt_id`:

```sql
select *
from public.tracking_sync_attempts
where id = 'SENTRY_ATTEMPT_ID';

select sequence, step, status, duration_ms, details, error_type, occurred_at
from public.tracking_sync_steps
where attempt_id = 'SENTRY_ATTEMPT_ID'
order by sequence;
```

Recent suspicious decisions:

```sql
select *
from public.tracking_sync_recent_anomalies
order by started_at desc
limit 100;
```

Repeated failures by carrier and error class:

```sql
select configured_carrier, error_type, count(*) as failures,
       min(started_at) as first_seen, max(started_at) as last_seen
from public.tracking_sync_attempts
where outcome in ('error', 'abandoned')
  and started_at >= now() - interval '7 days'
group by configured_carrier, error_type
order by failures desc, last_seen desc;
```

Attempts that have not completed (maintenance should empty this after 30
minutes):

```sql
select id, job_id, package_id, configured_carrier, current_step, started_at,
       now() - started_at as age
from public.tracking_sync_attempts
where outcome = 'running'
order by started_at;
```

When a classifier appears wrong, use `package_id` from the attempt to inspect
the account-private package and its already-normalized events. Do this only in
the database; never paste tracking numbers or event text into Sentry comments.

## Logs and correlation

Important JSON events are:

- `tracking_sync_started`, `tracking_sync_step`, and
  `tracking_sync_completed`, correlated by `attempt_id`;
- `tracking_sync_audit_write_failed` and
  `tracking_sync_audit_maintenance_failed`;
- `sync_claim_failed`, `sync_job_failed`, and `sync_job_finish_failed`,
  correlated by `job_id`; and
- `http_request`, correlated with Sentry by `request_id` for server errors.

The logging helper drops any field whose name looks like tracking, parcel,
package, user, label, description, location, status text, URL, token, cookie,
authorization, secret, or password data. Keep new fields scalar and bounded.

## Sentry behavior

The Node SDK is enabled only when `SENTRY_DSN` is set. Default PII collection
is disabled, tracing defaults to zero, request and fetch instrumentation is
removed, and a final event processor removes requests, users, breadcrumbs,
local variables, source context, arbitrary extras, and exception messages.

Issue fingerprints group by component, operation, carrier, anomaly/error type.
Opaque `attempt_id`, `job_id`, and `request_id` tags make individual executions
searchable. Daytime and overnight scheduled jobs send Sentry Cron check-ins;
the SDK creates monitors for the Zurich schedules and reports a missed or
failed run after one occurrence.

Recommended project alerts:

- notify on every new issue in the `production` environment;
- notify when a resolved issue regresses; and
- keep the automatically-created Cron monitor alerts enabled.

## Incident sequence

1. Read the Sentry component, operation, carrier, and error/anomaly type.
2. If present, copy only the opaque attempt id into the attempt and step
   queries above.
3. Confirm whether failure happened in carrier fetch, normalization, event
   persistence, or package persistence.
4. For classification anomalies, compare provider status, reported stage,
   selected stage, private status text, and normalized events.
5. Check nearby attempts for the same carrier to separate a single malformed
   shipment from a provider-wide change.
6. After remediation, run the provider tests and one controlled refresh, then
   verify the new audit row and Sentry recovery.
