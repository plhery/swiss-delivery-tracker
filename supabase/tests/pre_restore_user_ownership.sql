\set ON_ERROR_STOP on

-- Reproduce a row written while the app used its shared service-role backend.
-- The ownership migration must preserve it without exposing it to either user.
set role service_role;

insert into public.packages (
  id, tracking_number, label, carrier
) values (
  '50000000-0000-0000-0000-000000000005',
  'LEGACYSHARED2',
  'Legacy shared parcel',
  'planzer'
);

reset role;
