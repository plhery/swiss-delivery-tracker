\set ON_ERROR_STOP on

-- Reproduce the Swiss Post status rows written by the old substring classifier.
set role service_role;

insert into public.packages (
  id, user_id, tracking_number, label, carrier, current_stage,
  last_status_text, last_synced_at, sync_status
) values (
  '80000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'TOBEDELIVERED1',
  'Future delivery regression fixture',
  'swiss-post',
  'delivered',
  'TO_BE_DELIVERED',
  now(),
  'ok'
);

insert into public.tracking_events (
  package_id, stage, description, occurred_at, provider_event_id
) values (
  '80000000-0000-0000-0000-000000000008',
  'delivered',
  'TO_BE_DELIVERED',
  now(),
  'swiss-post:to-be-delivered-fixture'
);

reset role;
