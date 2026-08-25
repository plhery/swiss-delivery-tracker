-- Delivery-day Live Activities use their own ActivityKit tokens so they remain
-- independent from notification permission and account notification filters.

alter table public.native_push_devices
  add column installation_id uuid;

create index native_push_devices_installation_idx
  on public.native_push_devices (user_id, installation_id)
  where installation_id is not null and disabled_at is null;

create table public.live_activity_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id uuid not null,
  token text not null,
  environment text not null,
  locale text not null default 'en',
  subscribed_at timestamptz not null default now(),
  disabled_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installation_id),
  constraint live_activity_devices_token_check check (
    char_length(token) between 32 and 512
    and char_length(token) % 2 = 0
    and token ~ '^[0-9a-f]+$'
  ),
  constraint live_activity_devices_environment_check check (
    environment in ('development', 'production')
  ),
  constraint live_activity_devices_locale_check check (
    locale in ('en', 'de', 'fr', 'it')
  )
);

create index live_activity_devices_active_idx
  on public.live_activity_devices (user_id, installation_id)
  where disabled_at is null;

create table public.live_activity_update_tokens (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.live_activity_devices (id) on delete cascade,
  package_id uuid not null references public.packages (id) on delete cascade,
  activity_id text not null,
  token text not null,
  environment text not null,
  locale text not null default 'en',
  started_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, package_id),
  unique (device_id, activity_id),
  constraint live_activity_update_tokens_activity_check check (
    char_length(activity_id) between 1 and 128
    and activity_id ~ '^[A-Za-z0-9-]+$'
  ),
  constraint live_activity_update_tokens_token_check check (
    char_length(token) between 32 and 512
    and char_length(token) % 2 = 0
    and token ~ '^[0-9a-f]+$'
  ),
  constraint live_activity_update_tokens_environment_check check (
    environment in ('development', 'production')
  ),
  constraint live_activity_update_tokens_locale_check check (
    locale in ('en', 'de', 'fr', 'it')
  )
);

create index live_activity_update_tokens_device_idx
  on public.live_activity_update_tokens (device_id, started_at);

create table public.live_activity_event_deliveries (
  device_id uuid not null references public.live_activity_devices (id) on delete cascade,
  event_id uuid not null references public.tracking_events (id) on delete cascade,
  package_id uuid not null references public.packages (id) on delete cascade,
  delivery_kind text not null,
  event_created_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (device_id, event_id),
  constraint live_activity_event_deliveries_kind_check check (
    delivery_kind in ('start', 'update', 'end')
  )
);

create index live_activity_event_deliveries_package_idx
  on public.live_activity_event_deliveries (
    device_id,
    package_id,
    delivery_kind,
    event_created_at desc
  );

-- A local installation stays bound to only its current account. Routine token
-- refreshes retain the delivery cursor, while a re-enabled device or account
-- change starts fresh and discards activity state from the previous binding.
create function public.preserve_live_activity_subscription_epoch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id = old.user_id and old.disabled_at is null then
    new.subscribed_at := old.subscribed_at;
  else
    new.subscribed_at := now();
  end if;
  return new;
end;
$$;

create trigger live_activity_devices_preserve_subscription_epoch
before update on public.live_activity_devices
for each row execute function public.preserve_live_activity_subscription_epoch();

create function public.clear_live_activity_state_on_rebind()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    delete from public.live_activity_update_tokens where device_id = new.id;
    delete from public.live_activity_event_deliveries where device_id = new.id;
  end if;
  return new;
end;
$$;

create trigger live_activity_devices_clear_state_on_rebind
after update on public.live_activity_devices
for each row execute function public.clear_live_activity_state_on_rebind();

create function public.preserve_live_activity_start_epoch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.activity_id = old.activity_id then
    new.started_at := old.started_at;
  end if;
  return new;
end;
$$;

create trigger live_activity_tokens_preserve_start_epoch
before update on public.live_activity_update_tokens
for each row execute function public.preserve_live_activity_start_epoch();

create function public.enforce_live_activity_token_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.live_activity_devices as device
    join public.packages as package on package.id = new.package_id
    where device.id = new.device_id
      and device.user_id = package.user_id
  ) then
    raise exception 'Live Activity device and package owners must match'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger live_activity_tokens_enforce_owner
before insert or update on public.live_activity_update_tokens
for each row execute function public.enforce_live_activity_token_owner();

create function public.enforce_live_activity_delivery_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  actual_created_at timestamptz;
begin
  select event.created_at
  into actual_created_at
  from public.live_activity_devices as device
  join public.packages as package on package.id = new.package_id
  join public.tracking_events as event
    on event.id = new.event_id
   and event.package_id = package.id
  where device.id = new.device_id
    and device.user_id = package.user_id;

  if actual_created_at is null then
    raise exception 'Live Activity delivery owners and event must match'
      using errcode = '23514';
  end if;
  new.event_created_at := actual_created_at;
  return new;
end;
$$;

create trigger live_activity_deliveries_enforce_owner
before insert or update on public.live_activity_event_deliveries
for each row execute function public.enforce_live_activity_delivery_owner();

revoke all on function public.preserve_live_activity_subscription_epoch() from public;
revoke all on function public.clear_live_activity_state_on_rebind() from public;
revoke all on function public.preserve_live_activity_start_epoch() from public;
revoke all on function public.enforce_live_activity_token_owner() from public;
revoke all on function public.enforce_live_activity_delivery_owner() from public;

alter table public.live_activity_devices enable row level security;
alter table public.live_activity_update_tokens enable row level security;
alter table public.live_activity_event_deliveries enable row level security;

create view public.pending_live_activity_events
with (security_invoker = true) as
select
  device.id as device_id,
  device.token as push_to_start_token,
  device.environment,
  device.locale,
  update_token.id as update_token_id,
  update_token.activity_id,
  update_token.token as update_token,
  event.id as event_id,
  event.package_id,
  package.label,
  package.carrier,
  package.expected_delivery,
  event.stage,
  event.description,
  event.location,
  event.occurred_at,
  event.created_at as event_created_at,
  coalesce(preference.timezone, 'Europe/Zurich') as timezone
from public.live_activity_devices as device
join public.packages as package
  on package.user_id = device.user_id
join public.tracking_events as event
  on event.package_id = package.id
 and event.created_at > device.subscribed_at
 and event.provider_event_id is distinct from 'app:registered'
 and event.provider_event_id is distinct from 'app:pending'
 and event.stage <> 'pending'
left join public.live_activity_update_tokens as update_token
  on update_token.device_id = device.id
 and update_token.package_id = package.id
left join public.live_activity_event_deliveries as delivery
  on delivery.device_id = device.id
 and delivery.event_id = event.id
left join public.notification_preferences as preference
  on preference.user_id = device.user_id
where device.disabled_at is null
  and delivery.event_id is null
  and (
    (
      update_token.id is not null
      and event.created_at >= update_token.started_at
    )
    or (
      update_token.id is null
      and package.archived_at is null
      and package.current_stage = 'out_for_delivery'
      and event.stage = 'out_for_delivery'
      and package.id in (
        select candidate.id
        from public.packages as candidate
        where candidate.user_id = device.user_id
          and candidate.archived_at is null
          and candidate.current_stage = 'out_for_delivery'
        order by
          exists (
            select 1
            from public.live_activity_update_tokens as active_token
            where active_token.device_id = device.id
              and active_token.package_id = candidate.id
          ) desc,
          candidate.expected_delivery asc nulls last,
          (
            select max(candidate_event.occurred_at)
            from public.tracking_events as candidate_event
            where candidate_event.package_id = candidate.id
          ) desc nulls last,
          candidate.label asc,
          candidate.id asc
        limit 2
      )
      and not exists (
        select 1
        from public.live_activity_event_deliveries as prior_delivery
        where prior_delivery.device_id = device.id
          and prior_delivery.package_id = package.id
          and prior_delivery.delivery_kind = 'start'
          and prior_delivery.event_created_at > coalesce(
            (
              select max(reset_event.created_at)
              from public.tracking_events as reset_event
              where reset_event.package_id = package.id
                and reset_event.stage <> 'out_for_delivery'
                and reset_event.created_at < event.created_at
            ),
            '-infinity'::timestamptz
          )
      )
    )
  );

create or replace view public.pending_native_push_notifications
with (security_invoker = true) as
select
  device.id as device_id,
  device.token,
  device.environment,
  device.locale,
  event.id as event_id,
  event.package_id,
  package.label,
  event.stage,
  event.description,
  event.location,
  event.occurred_at,
  event.created_at as event_created_at,
  package.expected_delivery,
  (
    package.expected_delivery is not null
    and package.expected_delivery_changed_at is not null
    and package.expected_delivery_changed_at >= event.created_at
  ) as expected_delivery_changed,
  coalesce(preference.timezone, 'Europe/Zurich') as timezone,
  device.installation_id,
  live_delivery.event_id is not null as live_activity_delivered
from public.native_push_devices as device
join public.packages as package
  on package.user_id = device.user_id
join public.tracking_events as event
  on event.package_id = package.id
 and event.created_at > device.subscribed_at
 and event.provider_event_id is distinct from 'app:registered'
 and event.provider_event_id is distinct from 'app:pending'
 and event.stage <> 'pending'
left join public.notification_preferences as preference
  on preference.user_id = device.user_id
left join public.native_push_deliveries as delivery
  on delivery.device_id = device.id
 and delivery.event_id = event.id
left join public.live_activity_devices as live_device
  on live_device.user_id = device.user_id
 and live_device.installation_id = device.installation_id
 and live_device.disabled_at is null
left join public.live_activity_event_deliveries as live_delivery
  on live_delivery.device_id = live_device.id
 and live_delivery.event_id = event.id
where device.disabled_at is null
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

revoke all on public.live_activity_devices,
  public.live_activity_update_tokens,
  public.live_activity_event_deliveries
  from public, anon, authenticated;
revoke all on public.pending_live_activity_events,
  public.pending_native_push_notifications
  from public, anon, authenticated;

grant select, insert, update, delete
  on public.live_activity_devices,
  public.live_activity_update_tokens,
  public.live_activity_event_deliveries
  to service_role;
grant select on public.pending_live_activity_events,
  public.pending_native_push_notifications
  to service_role;

comment on column public.native_push_devices.installation_id is
  'Local iPhone installation identifier used only to correlate duplicate alert suppression.';
comment on table public.live_activity_devices is
  'Server-only ActivityKit push-to-start tokens for iPhone installations that enabled Live Activities.';
comment on table public.live_activity_update_tokens is
  'Server-only per-parcel ActivityKit update tokens for active delivery-day activities.';
comment on table public.live_activity_event_deliveries is
  'Durable ActivityKit delivery acknowledgements used for retries and duplicate alert suppression.';
comment on view public.pending_live_activity_events is
  'Delivery-day ActivityKit start, update, and end queue independent from notification preferences.';

notify pgrst, 'reload schema';
