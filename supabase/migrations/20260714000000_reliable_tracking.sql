-- Durable identity recovery and server-side carrier synchronization.

create extension if not exists pgcrypto with schema extensions;

alter table public.packages
  add column if not exists current_stage text not null default 'registered',
  add column if not exists expected_delivery text,
  add column if not exists last_status_text text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists sync_status text not null default 'pending',
  add column if not exists sync_error text,
  add column if not exists tracking_url text,
  add column if not exists carrier_data jsonb not null default '{}'::jsonb,
  add column if not exists archived_at timestamptz;

alter table public.packages
  drop constraint if exists packages_current_stage_check,
  add constraint packages_current_stage_check check (
    current_stage in (
      'registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered',
      'customs', 'failed_attempt', 'ready_for_pickup', 'returned'
    )
  ),
  drop constraint if exists packages_sync_status_check,
  add constraint packages_sync_status_check check (
    sync_status in ('pending', 'syncing', 'ok', 'waiting', 'error', 'unsupported')
  );

alter table public.tracking_events
  add column if not exists provider_event_id text,
  add column if not exists raw_data jsonb not null default '{}'::jsonb;

create unique index if not exists tracking_events_provider_event_idx
  on public.tracking_events (package_id, provider_event_id);

create or replace function public.add_initial_tracking_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tracking_events (
    package_id, stage, description, occurred_at, provider_event_id
  ) values (
    new.id, 'registered', 'Tracking added', new.created_at, 'app:registered'
  ) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists packages_add_initial_event on public.packages;
create trigger packages_add_initial_event
  after insert on public.packages
  for each row execute function public.add_initial_tracking_event();

insert into public.tracking_events (
  package_id, stage, description, occurred_at, provider_event_id
)
select p.id, 'registered', 'Tracking added', p.created_at, 'app:registered'
from public.packages p
where not exists (
  select 1 from public.tracking_events e where e.package_id = p.id
)
on conflict do nothing;

create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.delivery_recovery_codes (
  id bigint generated always as identity primary key,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by uuid references auth.users (id)
);

create or replace function public.claim_legacy_packages(recovery_code text)
returns integer
language plpgsql
security definer
set search_path = public, auth, private, extensions
as $$
declare
  target_user uuid := auth.uid();
  recovery_id bigint;
  moved integer := 0;
begin
  if target_user is null or exists (
    select 1 from auth.users where id = target_user and is_anonymous
  ) then
    raise exception 'A permanent account is required';
  end if;

  select id into recovery_id
  from private.delivery_recovery_codes
  where used_at is null
    and extensions.crypt(recovery_code, code_hash) = code_hash
  order by id desc
  limit 1
  for update;

  if recovery_id is null then
    raise exception 'Invalid or already-used recovery code';
  end if;

  update public.packages p
  set user_id = target_user
  where exists (
    select 1 from auth.users u where u.id = p.user_id and u.is_anonymous
  )
  and not exists (
    select 1
    from public.packages owned
    where owned.user_id = target_user
      and owned.tracking_number = p.tracking_number
  );
  get diagnostics moved = row_count;

  update private.delivery_recovery_codes
  set used_at = now(), used_by = target_user
  where id = recovery_id;

  return moved;
end;
$$;

revoke all on function public.claim_legacy_packages(text) from public;
grant execute on function public.claim_legacy_packages(text) to authenticated;
