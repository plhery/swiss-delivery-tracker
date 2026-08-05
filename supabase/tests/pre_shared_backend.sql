\set ON_ERROR_STOP on

-- Seed account-owned data before the shared-backend migration so the migration
-- suite proves that existing packages and their event history are preserved.
insert into auth.users (id, email)
values (
  '10000000-0000-0000-0000-000000000001',
  'legacy-owner@example.invalid'
);

insert into public.packages (
  id, user_id, tracking_number, label, carrier
) values (
  '40000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  'OWNER-TRACKING-1',
  'Existing parcel',
  'swiss-post'
);
