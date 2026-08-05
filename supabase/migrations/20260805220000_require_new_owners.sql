-- Preserve ownerless rows created by the former shared deployment long enough
-- for an explicit cutover, but never allow the public application or a future
-- service-role code path to create more of them.

alter table public.packages
  add constraint packages_owner_required_check
  check (user_id is not null) not valid;

alter table public.push_subscriptions
  add constraint push_subscriptions_owner_required_check
  check (user_id is not null) not valid;

comment on constraint packages_owner_required_check on public.packages is
  'Rejects new ownerless parcels while legacy cutover rows remain unvalidated.';

comment on constraint push_subscriptions_owner_required_check on public.push_subscriptions is
  'Rejects new ownerless subscriptions; pre-auth devices must opt in again.';
