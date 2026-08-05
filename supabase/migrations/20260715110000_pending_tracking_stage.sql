-- Adding a tracking number only means the app should start looking for it.
-- It must not imply that the carrier has already announced the shipment.

alter table public.tracking_events
  drop constraint if exists tracking_events_stage_check,
  add constraint tracking_events_stage_check check (
    stage in (
      'pending', 'registered', 'accepted', 'in_transit', 'out_for_delivery',
      'delivered', 'customs', 'failed_attempt', 'ready_for_pickup', 'returned'
    )
  );

alter table public.packages
  alter column current_stage set default 'pending',
  drop constraint if exists packages_current_stage_check,
  add constraint packages_current_stage_check check (
    current_stage in (
      'pending', 'registered', 'accepted', 'in_transit', 'out_for_delivery',
      'delivered', 'customs', 'failed_attempt', 'ready_for_pickup', 'returned'
    )
  );

update public.tracking_events
set stage = 'pending',
    provider_event_id = 'app:pending'
where provider_event_id = 'app:registered';

update public.packages as package
set current_stage = 'pending'
where package.current_stage = 'registered'
  and exists (
    select 1
    from public.tracking_events as event
    where event.package_id = package.id
      and event.provider_event_id = 'app:pending'
  )
  and not exists (
    select 1
    from public.tracking_events as event
    where event.package_id = package.id
      and event.provider_event_id is distinct from 'app:pending'
  );

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
    new.id, 'pending', 'Tracking added', new.created_at, 'app:pending'
  ) on conflict do nothing;
  return new;
end;
$$;

-- App-created and carrier-pending events are state bookkeeping, not delivery
-- updates worth notifying every subscribed device about.
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
  event.created_at as event_created_at
from public.push_subscriptions as subscription
join public.tracking_events as event
  on event.created_at > subscription.subscribed_at
 and event.provider_event_id is distinct from 'app:registered'
 and event.provider_event_id is distinct from 'app:pending'
 and event.stage <> 'pending'
join public.packages as package on package.id = event.package_id
left join public.push_deliveries as delivery
  on delivery.subscription_id = subscription.id
 and delivery.event_id = event.id
where subscription.disabled_at is null
  and delivery.event_id is null;

notify pgrst, 'reload schema';
