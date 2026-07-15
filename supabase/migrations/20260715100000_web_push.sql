-- Durable Web Push delivery. Subscriptions are server-only credentials and
-- each tracking event is acknowledged per device after a successful send.

alter table public.tracking_events
  add column if not exists created_at timestamptz not null default now();

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  subscribed_at timestamptz not null default now(),
  disabled_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_deliveries (
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  event_id uuid not null references public.tracking_events(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (subscription_id, event_id)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_deliveries enable row level security;

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
join public.packages as package on package.id = event.package_id
left join public.push_deliveries as delivery
  on delivery.subscription_id = subscription.id
 and delivery.event_id = event.id
where subscription.disabled_at is null
  and delivery.event_id is null;

revoke all on public.push_subscriptions, public.push_deliveries from public, anon, authenticated;
revoke all on public.pending_push_notifications from public, anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions, public.push_deliveries to service_role;
grant select on public.pending_push_notifications to service_role;

comment on table public.push_subscriptions is
  'Server-only Web Push endpoints. Endpoints and keys must never be exposed to browser database roles.';
comment on table public.push_deliveries is
  'Per-device acknowledgements used to retry only notifications that were not delivered successfully.';
