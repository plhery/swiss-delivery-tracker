-- Keep the parcel's current delivery estimate in every push notification. The
-- change timestamp lets the copy distinguish a newly learned estimate from an
-- estimate that was already known when the tracking event arrived.

alter table public.packages
  add column expected_delivery_changed_at timestamptz;

create function public.mark_expected_delivery_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.expected_delivery is distinct from old.expected_delivery then
    new.expected_delivery_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger packages_mark_expected_delivery_change
before update of expected_delivery on public.packages
for each row execute function public.mark_expected_delivery_change();

revoke all on function public.mark_expected_delivery_change() from public;

create or replace view public.pending_push_notifications
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
  event.created_at as event_created_at,
  package.expected_delivery,
  (
    package.expected_delivery is not null
    and package.expected_delivery_changed_at is not null
    and package.expected_delivery_changed_at >= event.created_at
  ) as expected_delivery_changed,
  coalesce(preference.timezone, 'Europe/Zurich') as timezone
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
  coalesce(preference.timezone, 'Europe/Zurich') as timezone
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

revoke all on public.pending_push_notifications, public.pending_native_push_notifications
  from public, anon, authenticated;
grant select on public.pending_push_notifications, public.pending_native_push_notifications
  to service_role;

comment on column public.packages.expected_delivery_changed_at is
  'Timestamp of the latest delivery-estimate change, used to phrase push notification ETAs.';
comment on function public.mark_expected_delivery_change() is
  'Records when a carrier supplies or changes the parcel delivery estimate.';

notify pgrst, 'reload schema';
