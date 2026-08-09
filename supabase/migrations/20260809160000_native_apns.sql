-- Native iPhone push subscriptions. Device tokens remain server-only and use
-- the same account preferences, quiet hours, parcel mute, and durable
-- per-event acknowledgements as browser Web Push.

create table public.native_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null,
  environment text not null,
  locale text not null default 'en',
  device_name text,
  subscribed_at timestamptz not null default now(),
  disabled_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (environment, token),
  constraint native_push_devices_token_check check (
    char_length(token) between 32 and 512
    and char_length(token) % 2 = 0
    and token ~ '^[0-9a-f]+$'
  ),
  constraint native_push_devices_environment_check check (
    environment in ('development', 'production')
  ),
  constraint native_push_devices_locale_check check (
    locale in ('en', 'de', 'fr', 'it')
  ),
  constraint native_push_devices_name_check check (
    device_name is null or char_length(device_name) <= 100
  )
);

create index native_push_devices_user_idx
  on public.native_push_devices (user_id)
  where disabled_at is null;

-- The app intentionally forwards Apple's current opaque token every launch.
-- Preserve the delivery cursor for an already-active device so a routine
-- refresh cannot skip events that have not been acknowledged yet. A device
-- moving to another account, or an expired device being re-enabled, starts a
-- fresh cursor and never receives a backlog from before that registration.
create function public.preserve_native_push_subscription_epoch()
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

create trigger native_push_devices_preserve_subscription_epoch
before update on public.native_push_devices
for each row execute function public.preserve_native_push_subscription_epoch();

revoke all on function public.preserve_native_push_subscription_epoch() from public;

create table public.native_push_deliveries (
  device_id uuid not null references public.native_push_devices (id) on delete cascade,
  event_id uuid not null references public.tracking_events (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (device_id, event_id)
);

alter table public.native_push_devices enable row level security;
alter table public.native_push_deliveries enable row level security;

create view public.pending_native_push_notifications
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
  event.created_at as event_created_at
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

revoke all on public.native_push_devices, public.native_push_deliveries
  from public, anon, authenticated;
revoke all on public.pending_native_push_notifications
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.native_push_devices, public.native_push_deliveries
  to service_role;
grant select on public.pending_native_push_notifications to service_role;

comment on table public.native_push_devices is
  'Server-only APNs device tokens bound to the account that registered them.';
comment on function public.preserve_native_push_subscription_epoch() is
  'Keeps routine APNs token refreshes from advancing the durable delivery cursor.';
comment on table public.native_push_deliveries is
  'Per-iPhone acknowledgements for successful APNs tracking event delivery.';
comment on view public.pending_native_push_notifications is
  'Filtered APNs queue honoring account preferences, quiet hours, and parcel mutes.';
comment on table public.notification_preferences is
  'Account-wide event filters and quiet hours applied before Web Push and APNs delivery.';
comment on column public.packages.notifications_muted is
  'True when the parcel owner has muted browser and native push updates for this package.';

notify pgrst, 'reload schema';
