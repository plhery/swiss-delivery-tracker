-- Account-wide notification filters and per-parcel muting. The pending queue
-- applies both controls so every registered device follows the same choices.

alter table public.packages
  add column notifications_muted boolean not null default false;

create table public.notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled_stages text[] not null default array[
    'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery',
    'failed_attempt', 'ready_for_pickup', 'delivered', 'returned'
  ]::text[],
  quiet_hours_start time,
  quiet_hours_end time,
  timezone text not null default 'Europe/Zurich',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_preferences_stages_check check (
    cardinality(enabled_stages) between 1 and 9
    and enabled_stages <@ array[
      'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery',
      'failed_attempt', 'ready_for_pickup', 'delivered', 'returned'
    ]::text[]
  ),
  constraint notification_preferences_quiet_hours_check check (
    (quiet_hours_start is null and quiet_hours_end is null)
    or (
      quiet_hours_start is not null
      and quiet_hours_end is not null
      and quiet_hours_start <> quiet_hours_end
    )
  ),
  constraint notification_preferences_timezone_length_check check (
    char_length(timezone) between 1 and 64
  )
);

alter table public.notification_preferences enable row level security;

create policy "select own notification preferences"
  on public.notification_preferences
  for select to authenticated
  using (user_id = auth.uid());

revoke all on public.notification_preferences from public, anon, authenticated;
grant select on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.notification_preferences to service_role;

create or replace function public.set_owned_notification_preferences(
  p_enabled_stages text[],
  p_quiet_hours_start time default null,
  p_quiet_hours_end time default null,
  p_timezone text default 'Europe/Zurich'
)
returns public.notification_preferences
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor_id uuid := auth.uid();
  saved public.notification_preferences;
begin
  if actor_id is null or exists (
    select 1 from auth.users where id = actor_id and is_anonymous
  ) then
    raise exception 'A permanent account is required' using errcode = '42501';
  end if;
  if p_enabled_stages is null
      or cardinality(p_enabled_stages) not between 1 and 9
      or not p_enabled_stages <@ array[
        'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery',
        'failed_attempt', 'ready_for_pickup', 'delivered', 'returned'
      ]::text[]
      or cardinality(p_enabled_stages) <> cardinality(array(
        select distinct stage from unnest(p_enabled_stages) as stage
      )) then
    raise exception 'Invalid notification stages' using errcode = '22023';
  end if;
  if (p_quiet_hours_start is null) <> (p_quiet_hours_end is null)
      or p_quiet_hours_start = p_quiet_hours_end then
    raise exception 'Invalid quiet hours' using errcode = '22023';
  end if;
  if p_timezone is null
      or char_length(p_timezone) not between 1 and 64
      or not exists (
        select 1 from pg_catalog.pg_timezone_names where name = p_timezone
      ) then
    raise exception 'Invalid timezone' using errcode = '22023';
  end if;

  insert into public.notification_preferences (
    user_id,
    enabled_stages,
    quiet_hours_start,
    quiet_hours_end,
    timezone,
    updated_at
  ) values (
    actor_id,
    p_enabled_stages,
    p_quiet_hours_start,
    p_quiet_hours_end,
    p_timezone,
    now()
  )
  on conflict (user_id) do update set
    enabled_stages = excluded.enabled_stages,
    quiet_hours_start = excluded.quiet_hours_start,
    quiet_hours_end = excluded.quiet_hours_end,
    timezone = excluded.timezone,
    updated_at = excluded.updated_at
  returning * into saved;

  return saved;
end;
$$;

create or replace function public.set_owned_package_notifications_muted(
  p_package_id uuid,
  p_muted boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  changed uuid;
begin
  if auth.uid() is null or p_muted is null then
    raise exception 'Invalid notification setting' using errcode = '22023';
  end if;

  update public.packages
  set notifications_muted = p_muted
  where id = p_package_id
    and user_id = auth.uid()
  returning id into changed;

  return changed is not null;
end;
$$;

revoke all on function public.set_owned_notification_preferences(text[], time, time, text)
  from public;
revoke all on function public.set_owned_package_notifications_muted(uuid, boolean)
  from public;
grant execute on function public.set_owned_notification_preferences(text[], time, time, text)
  to authenticated;
grant execute on function public.set_owned_package_notifications_muted(uuid, boolean)
  to authenticated;

drop view if exists public.pending_push_notifications;
create view public.pending_push_notifications
with (security_invoker = true) as
select
  subscription.id as subscription_id,
  subscription.endpoint,
  subscription.p256dh,
  subscription.auth,
  event.id as event_id,
  event.package_id,
  package.label,
  event.stage,
  event.description,
  event.location,
  event.occurred_at,
  event.created_at as event_created_at
from public.push_subscriptions as subscription
join public.packages as package
  on package.user_id = subscription.user_id
join public.tracking_events as event
  on event.package_id = package.id
 and event.created_at > subscription.subscribed_at
 and event.provider_event_id is distinct from 'app:registered'
 and event.provider_event_id is distinct from 'app:pending'
 and event.stage <> 'pending'
left join public.notification_preferences as preference
  on preference.user_id = subscription.user_id
left join public.push_deliveries as delivery
  on delivery.subscription_id = subscription.id
 and delivery.event_id = event.id
where subscription.disabled_at is null
  and subscription.user_id is not null
  and package.notifications_muted is false
  and event.stage = any(coalesce(
    preference.enabled_stages,
    array[
      'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery',
      'failed_attempt', 'ready_for_pickup', 'delivered', 'returned'
    ]::text[]
  ))
  and (
    preference.quiet_hours_start is null
    or preference.quiet_hours_end is null
    or case
      when preference.quiet_hours_start < preference.quiet_hours_end then
        (now() at time zone preference.timezone)::time < preference.quiet_hours_start
        or (now() at time zone preference.timezone)::time >= preference.quiet_hours_end
      else
        (now() at time zone preference.timezone)::time < preference.quiet_hours_start
        and (now() at time zone preference.timezone)::time >= preference.quiet_hours_end
      end
  )
  and delivery.event_id is null;

revoke all on public.pending_push_notifications from public, anon, authenticated;
grant select on public.pending_push_notifications to service_role;

comment on table public.notification_preferences is
  'Account-wide event filters and quiet hours applied before Web Push delivery.';
comment on column public.packages.notifications_muted is
  'True when the parcel owner has muted Web Push updates for this package.';
comment on function public.set_owned_package_notifications_muted(uuid, boolean) is
  'Changes only the current account owner notification setting for one package.';

notify pgrst, 'reload schema';
