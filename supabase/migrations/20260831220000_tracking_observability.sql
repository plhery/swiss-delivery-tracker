-- Retain a private, service-role-only explanation of every carrier refresh.
-- Sentry and application logs contain only the opaque attempt id; operators
-- can use that id here to inspect the complete normalization decision without
-- putting tracking data in a third-party telemetry system.

create table public.tracking_sync_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.sync_jobs (id) on delete set null,
  package_id uuid not null references public.packages (id) on delete cascade,
  trigger text not null,
  configured_carrier text not null,
  source_carrier text,
  outcome text not null default 'running',
  current_step text not null default 'selected',
  previous_stage text,
  provider_status text,
  reported_stage text,
  selected_stage text,
  status_text text,
  events_received integer not null default 0,
  events_normalized integer not null default 0,
  anomaly_codes text[] not null default '{}'::text[],
  error_type text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer,
  constraint tracking_sync_attempts_trigger_check check (
    trigger in ('package', 'scheduled')
  ),
  constraint tracking_sync_attempts_outcome_check check (
    outcome in ('running', 'updated', 'waiting', 'error', 'unsupported', 'abandoned')
  ),
  constraint tracking_sync_attempts_step_check check (
    current_step in (
      'selected', 'fetch', 'normalize', 'persist_events', 'persist_package', 'complete'
    )
  ),
  constraint tracking_sync_attempts_carrier_check check (
    length(configured_carrier) between 1 and 100
    and (source_carrier is null or length(source_carrier) between 1 and 100)
  ),
  constraint tracking_sync_attempts_status_check check (
    provider_status is null
    or provider_status in (
      'pending', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'unknown'
    )
  ),
  constraint tracking_sync_attempts_stage_lengths_check check (
    (previous_stage is null or length(previous_stage) between 1 and 100)
    and (reported_stage is null or length(reported_stage) between 1 and 100)
    and (selected_stage is null or length(selected_stage) between 1 and 100)
  ),
  constraint tracking_sync_attempts_status_text_check check (
    status_text is null or length(status_text) <= 500
  ),
  constraint tracking_sync_attempts_counts_check check (
    events_received between 0 and 10000
    and events_normalized between 0 and 10000
  ),
  constraint tracking_sync_attempts_anomalies_check check (
    cardinality(anomaly_codes) <= 16
  ),
  constraint tracking_sync_attempts_error_type_check check (
    error_type is null or length(error_type) between 1 and 100
  ),
  constraint tracking_sync_attempts_duration_check check (
    duration_ms is null or duration_ms >= 0
  ),
  constraint tracking_sync_attempts_completion_check check (
    (outcome = 'running' and completed_at is null)
    or (outcome <> 'running' and completed_at is not null)
  )
);

create table public.tracking_sync_steps (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references public.tracking_sync_attempts (id) on delete cascade,
  sequence smallint not null,
  step text not null,
  status text not null,
  occurred_at timestamptz not null default now(),
  duration_ms integer,
  details jsonb not null default '{}'::jsonb,
  error_type text,
  constraint tracking_sync_steps_attempt_sequence_key unique (attempt_id, sequence),
  constraint tracking_sync_steps_sequence_check check (sequence between 1 and 32),
  constraint tracking_sync_steps_step_check check (
    step in (
      'selected', 'fetch', 'normalize', 'persist_events', 'persist_package', 'complete'
    )
  ),
  constraint tracking_sync_steps_status_check check (
    status in ('succeeded', 'failed', 'skipped')
  ),
  constraint tracking_sync_steps_duration_check check (
    duration_ms is null or duration_ms >= 0
  ),
  constraint tracking_sync_steps_details_check check (
    jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4096
  ),
  constraint tracking_sync_steps_error_type_check check (
    error_type is null or length(error_type) between 1 and 100
  )
);

create index tracking_sync_attempts_package_started_idx
  on public.tracking_sync_attempts (package_id, started_at desc);
create index tracking_sync_attempts_carrier_started_idx
  on public.tracking_sync_attempts (configured_carrier, started_at desc);
create index tracking_sync_attempts_outcome_started_idx
  on public.tracking_sync_attempts (outcome, started_at desc);
create index tracking_sync_attempts_anomalies_idx
  on public.tracking_sync_attempts using gin (anomaly_codes);
create index tracking_sync_attempts_running_idx
  on public.tracking_sync_attempts (started_at)
  where outcome = 'running';
create index tracking_sync_steps_attempt_idx
  on public.tracking_sync_steps (attempt_id, sequence);

alter table public.tracking_sync_attempts enable row level security;
alter table public.tracking_sync_steps enable row level security;
revoke all on public.tracking_sync_attempts from public, anon, authenticated;
revoke all on public.tracking_sync_steps from public, anon, authenticated;
revoke all on sequence public.tracking_sync_steps_id_seq from public, anon, authenticated;
grant select, insert, update, delete on public.tracking_sync_attempts to service_role;
grant select, insert, update, delete on public.tracking_sync_steps to service_role;
grant usage, select on sequence public.tracking_sync_steps_id_seq to service_role;

-- Complete an attempt and write its in-memory step trace in one transaction.
-- Keeping this server-side avoids a misleading half-finished ledger if the
-- worker loses its database connection between the two writes.
create function public.complete_tracking_sync_attempt(
  p_attempt_id uuid,
  p_values jsonb,
  p_steps jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if jsonb_typeof(p_values) <> 'object' or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'Invalid tracking sync audit payload' using errcode = '22023';
  end if;

  insert into public.tracking_sync_steps (
    attempt_id,
    sequence,
    step,
    status,
    occurred_at,
    duration_ms,
    details,
    error_type
  )
  select
    p_attempt_id,
    row.sequence,
    row.step,
    row.status,
    coalesce(row.occurred_at, now()),
    row.duration_ms,
    coalesce(row.details, '{}'::jsonb),
    row.error_type
  from jsonb_to_recordset(p_steps) as row(
    sequence smallint,
    step text,
    status text,
    occurred_at timestamptz,
    duration_ms integer,
    details jsonb,
    error_type text
  )
  on conflict (attempt_id, sequence) do update set
    step = excluded.step,
    status = excluded.status,
    occurred_at = excluded.occurred_at,
    duration_ms = excluded.duration_ms,
    details = excluded.details,
    error_type = excluded.error_type;

  update public.tracking_sync_attempts
  set
    source_carrier = case
      when p_values ? 'source_carrier' then nullif(p_values ->> 'source_carrier', '')
      else source_carrier
    end,
    outcome = p_values ->> 'outcome',
    current_step = 'complete',
    provider_status = nullif(p_values ->> 'provider_status', ''),
    reported_stage = nullif(p_values ->> 'reported_stage', ''),
    selected_stage = nullif(p_values ->> 'selected_stage', ''),
    status_text = nullif(left(p_values ->> 'status_text', 500), ''),
    events_received = coalesce((p_values ->> 'events_received')::integer, 0),
    events_normalized = coalesce((p_values ->> 'events_normalized')::integer, 0),
    anomaly_codes = coalesce(
      array(select jsonb_array_elements_text(p_values -> 'anomaly_codes')),
      '{}'::text[]
    ),
    error_type = nullif(p_values ->> 'error_type', ''),
    completed_at = coalesce((p_values ->> 'completed_at')::timestamptz, now()),
    duration_ms = (p_values ->> 'duration_ms')::integer
  where id = p_attempt_id
    and outcome = 'running';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.complete_tracking_sync_attempt(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_tracking_sync_attempt(uuid, jsonb, jsonb)
  to service_role;

-- A scheduled call marks hard-crashed attempts and bounds private audit data.
create function public.maintain_tracking_sync_audit()
returns table (abandoned integer, purged integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  abandoned_count integer;
  purged_count integer;
begin
  update public.tracking_sync_attempts
  set
    outcome = 'abandoned',
    current_step = 'complete',
    completed_at = now(),
    duration_ms = greatest(0, least(
      2147483647,
      floor(extract(epoch from (now() - started_at)) * 1000)
    ))::integer,
    error_type = 'WorkerAbandonedAttempt',
    anomaly_codes = array_append(anomaly_codes, 'worker_abandoned_attempt')
  where outcome = 'running'
    and started_at < now() - interval '30 minutes';
  get diagnostics abandoned_count = row_count;

  delete from public.tracking_sync_attempts
  where outcome <> 'running'
    and completed_at < now() - interval '90 days';
  get diagnostics purged_count = row_count;

  return query select abandoned_count, purged_count;
end;
$$;

revoke all on function public.maintain_tracking_sync_audit()
  from public, anon, authenticated;
grant execute on function public.maintain_tracking_sync_audit() to service_role;

create view public.tracking_sync_health_24h
with (security_invoker = true)
as
select
  configured_carrier,
  count(*) as attempts,
  count(*) filter (where outcome = 'updated') as updated,
  count(*) filter (where outcome = 'waiting') as waiting,
  count(*) filter (where outcome = 'error') as errors,
  count(*) filter (where outcome = 'unsupported') as unsupported,
  count(*) filter (where outcome = 'abandoned') as abandoned,
  count(*) filter (where cardinality(anomaly_codes) > 0) as anomalous,
  round(
    100.0 * count(*) filter (where outcome in ('error', 'abandoned'))
      / nullif(count(*), 0),
    2
  ) as error_percent,
  max(started_at) as last_attempt_at
from public.tracking_sync_attempts
where started_at >= now() - interval '24 hours'
group by configured_carrier;

create view public.tracking_sync_recent_anomalies
with (security_invoker = true)
as
select
  id as attempt_id,
  job_id,
  package_id,
  configured_carrier,
  source_carrier,
  outcome,
  previous_stage,
  provider_status,
  reported_stage,
  selected_stage,
  status_text,
  events_received,
  events_normalized,
  anomaly_codes,
  error_type,
  started_at,
  completed_at,
  duration_ms
from public.tracking_sync_attempts
where outcome in ('error', 'abandoned')
  or cardinality(anomaly_codes) > 0;

revoke all on public.tracking_sync_health_24h from public, anon, authenticated;
revoke all on public.tracking_sync_recent_anomalies from public, anon, authenticated;
grant select on public.tracking_sync_health_24h to service_role;
grant select on public.tracking_sync_recent_anomalies to service_role;

comment on table public.tracking_sync_attempts is
  'Private per-package carrier refresh decisions, correlated to Sentry by opaque attempt id.';
comment on table public.tracking_sync_steps is
  'Private step trace for a carrier refresh; contains no tracking number or raw payload.';
comment on column public.tracking_sync_attempts.status_text is
  'Bounded provider summary retained only in the private database for classification debugging.';
comment on function public.maintain_tracking_sync_audit() is
  'Marks hard-crashed attempts after 30 minutes and purges completed audit rows after 90 days.';

notify pgrst, 'reload schema';
