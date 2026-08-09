-- Persist carrier sync work so deploys and process restarts cannot lose a
-- user-requested refresh. Only the service-role worker can see or mutate jobs;
-- users receive a deliberately small status projection through the app API.

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  package_id uuid references public.packages (id) on delete cascade,
  kind text not null,
  state text not null default 'queued',
  dedupe_key text unique,
  priority smallint not null default 0,
  requested_at timestamptz not null default now(),
  run_after timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_until timestamptz,
  locked_by text,
  attempts integer not null default 0,
  result jsonb,
  last_error text,
  constraint sync_jobs_kind_check check (kind in ('package', 'scheduled')),
  constraint sync_jobs_state_check check (
    state in ('queued', 'running', 'succeeded', 'failed')
  ),
  constraint sync_jobs_attempts_check check (attempts between 0 and 3),
  constraint sync_jobs_target_check check (
    (kind = 'package' and user_id is not null and package_id is not null)
    or (kind = 'scheduled' and user_id is null and package_id is null)
  )
);

create index sync_jobs_claim_idx
  on public.sync_jobs (priority desc, run_after, requested_at)
  where state in ('queued', 'running');
create index sync_jobs_user_idx
  on public.sync_jobs (user_id, requested_at desc)
  where user_id is not null;
create index sync_jobs_completed_idx
  on public.sync_jobs (completed_at)
  where state in ('succeeded', 'failed');

alter table public.sync_jobs enable row level security;
revoke all on public.sync_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.sync_jobs to service_role;

-- Claim one runnable job atomically. SKIP LOCKED permits multiple replicas to
-- share the queue, while leases make a crashed worker's job recoverable.
create function public.claim_sync_job(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns setof public.sync_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(p_worker_id), '') is null
      or p_lease_seconds not between 30 and 3600 then
    raise exception 'Invalid worker lease' using errcode = '22023';
  end if;

  delete from public.sync_jobs
  where state in ('succeeded', 'failed')
    and completed_at < now() - interval '30 days';

  update public.sync_jobs
  set
    state = 'failed',
    completed_at = now(),
    lease_until = null,
    locked_by = null,
    dedupe_key = null,
    last_error = 'The sync worker stopped before completing this job.'
  where state = 'running'
    and lease_until < now()
    and attempts >= 3;

  return query
  with candidate as (
    select job.id
    from public.sync_jobs as job
    where (
      (job.state = 'queued' and job.run_after <= now())
      or (
        job.state = 'running'
        and job.lease_until < now()
        and job.attempts < 3
      )
    )
    order by job.priority desc, job.run_after, job.requested_at
    for update skip locked
    limit 1
  )
  update public.sync_jobs as job
  set
    state = 'running',
    started_at = coalesce(job.started_at, now()),
    completed_at = null,
    lease_until = now() + make_interval(secs => p_lease_seconds),
    locked_by = p_worker_id,
    attempts = job.attempts + 1,
    last_error = null
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

revoke all on function public.claim_sync_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_sync_job(text, integer) to service_role;

comment on table public.sync_jobs is
  'Durable, leased work queue for user and scheduled carrier synchronization.';
comment on function public.claim_sync_job(text, integer) is
  'Atomically leases one runnable sync job to a service-role worker.';

notify pgrst, 'reload schema';
