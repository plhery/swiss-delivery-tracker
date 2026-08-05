-- Bind each browser push endpoint to the account that registered it. An
-- endpoint stays globally unique because a browser subscription can belong to
-- only the account currently using that device.

alter table public.push_subscriptions
  add column user_id uuid references auth.users (id) on delete cascade;

create index push_subscriptions_user_idx
  on public.push_subscriptions (user_id)
  where disabled_at is null;

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
left join public.push_deliveries as delivery
  on delivery.subscription_id = subscription.id
 and delivery.event_id = event.id
where subscription.disabled_at is null
  and subscription.user_id is not null
  and delivery.event_id is null;

revoke all on public.pending_push_notifications from public, anon, authenticated;
grant select on public.pending_push_notifications to service_role;

comment on column public.push_subscriptions.user_id is
  'Supabase Auth owner. NULL is reserved for subscriptions created before the public-auth cutover.';

notify pgrst, 'reload schema';
