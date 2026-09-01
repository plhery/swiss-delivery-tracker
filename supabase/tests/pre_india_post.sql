\set ON_ERROR_STOP on

-- Reproduce an India-issued S10 shipment stored under the generic fallback
-- before the dedicated automatic adapter existed.
set role service_role;

insert into public.packages (
  id, user_id, tracking_number, label, carrier, current_stage,
  last_status_text, last_synced_at, sync_status, carrier_data
) values (
  '81000000-0000-0000-0000-000000000081',
  '10000000-0000-0000-0000-000000000001',
  'JN067614884IN',
  'India Post migration fixture',
  'intl-post',
  'in_transit',
  'Generic postal state',
  now(),
  'ok',
  '{"legacy":true}'::jsonb
);

insert into public.tracking_events (
  package_id, stage, description, occurred_at, provider_event_id
) values (
  '81000000-0000-0000-0000-000000000081',
  'in_transit',
  'Generic postal state',
  now(),
  'intl-post:legacy-fixture'
);

insert into public.sync_jobs (
  id, user_id, package_id, kind, state, dedupe_key
) values (
  '82000000-0000-0000-0000-000000000082',
  '10000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000081',
  'package',
  'queued',
  'package:india-post-migration-fixture'
);

reset role;
