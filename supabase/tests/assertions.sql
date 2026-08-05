\set ON_ERROR_STOP on

-- Account-owned data and shared-backend data both survive the migration. Only
-- the account-owned row is public through RLS; the unowned row awaits cutover.
do $$
declare
  initial_events integer;
begin
  select count(*) into initial_events
  from public.tracking_events
  where package_id = '40000000-0000-0000-0000-000000000004'
    and provider_event_id = 'app:pending'
    and stage = 'pending';
  if initial_events <> 1 then
    raise exception 'pending tracking event migration produced % rows', initial_events;
  end if;

  if (select current_stage from public.packages where id = '40000000-0000-0000-0000-000000000004')
      <> 'pending' then
    raise exception 'package was announced before the carrier reported it';
  end if;

  if (select user_id from public.packages where id = '40000000-0000-0000-0000-000000000004')
      <> '10000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'existing owner was not preserved';
  end if;

  if (select user_id is not null from public.packages where id = '50000000-0000-0000-0000-000000000005') then
    raise exception 'legacy shared package was assigned to an arbitrary account';
  end if;

  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'packages_tracking_number_shared_key'
  ) then
    raise exception 'global tracking-number uniqueness still exists';
  end if;
end;
$$;

insert into auth.users (id, email)
values (
  '20000000-0000-0000-0000-000000000002',
  'second-owner@example.invalid'
);

-- The service role remains the private background worker and can process every
-- tenant while explicitly preserving package ownership.
set role service_role;

insert into public.packages (
  id, user_id, tracking_number, label, carrier
) values (
  '70000000-0000-0000-0000-000000000007',
  '20000000-0000-0000-0000-000000000002',
  'CROSSTENANT9',
  'Second owner parcel',
  'planzer'
);

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.packages;
  if visible <> 3 then
    raise exception 'service role could not see every ownership state';
  end if;
end;
$$;

reset role;

-- The first user sees only their parcel, can create another parcel with the
-- same tracking number as another user, and cannot alter server-owned fields.
set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);

do $$
declare
  visible integer;
  affected integer;
begin
  select count(*) into visible from public.packages;
  if visible <> 1 then
    raise exception 'first user could see % packages before inserting', visible;
  end if;

  if exists (
    select 1 from public.packages
    where id in (
      '50000000-0000-0000-0000-000000000005',
      '70000000-0000-0000-0000-000000000007'
    )
  ) then
    raise exception 'first user could see an unowned or second-user package';
  end if;

  if exists (
    select 1 from public.tracking_events
    where package_id in (
      '50000000-0000-0000-0000-000000000005',
      '70000000-0000-0000-0000-000000000007'
    )
  ) then
    raise exception 'first user could see another package history';
  end if;

  update public.packages
  set label = 'Cross-tenant update'
  where id = '70000000-0000-0000-0000-000000000007';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'first user updated a second-user package';
  end if;

  delete from public.packages
  where id = '70000000-0000-0000-0000-000000000007';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'first user deleted a second-user package';
  end if;

  begin
    update public.packages set current_stage = 'delivered';
    raise exception 'authenticated user changed a server-owned package field';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into public.tracking_events (package_id, stage)
    values ('40000000-0000-0000-0000-000000000004', 'delivered');
    raise exception 'authenticated user inserted a carrier event';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into public.packages (user_id, tracking_number)
    values ('20000000-0000-0000-0000-000000000002', 'STOLENOWNER8');
    raise exception 'authenticated user selected a different owner';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

insert into public.packages (tracking_number, label, carrier)
values ('CROSSTENANT9', 'Same number, first owner', 'planzer');

do $$
begin
  if not exists (
    select 1 from public.packages
    where tracking_number = 'CROSSTENANT9'
      and user_id = '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'auth.uid() did not become the new package owner';
  end if;

  begin
    insert into public.packages (tracking_number, carrier)
    values ('CROSSTENANT9', 'planzer');
    raise exception 'same-user duplicate tracking number was accepted';
  exception when unique_violation then
    null;
  end;
end;
$$;

reset role;

-- The second user sees their copy of the tracking number and nothing from the
-- first user or the unowned cutover collection.
set role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.packages;
  if visible <> 1 then
    raise exception 'second user could see % packages', visible;
  end if;
  if not exists (
    select 1 from public.packages
    where id = '70000000-0000-0000-0000-000000000007'
  ) then
    raise exception 'second user could not see their package';
  end if;
  if exists (
    select 1 from public.packages
    where id in (
      '40000000-0000-0000-0000-000000000004',
      '50000000-0000-0000-0000-000000000005'
    )
  ) then
    raise exception 'second user could see first-user or unowned data';
  end if;
end;
$$;

reset role;

-- Anonymous database access stays closed even though the application itself
-- is now publicly reachable.
set role anon;

do $$
begin
  begin
    perform count(*) from public.packages;
    raise exception 'anonymous package reads were accepted';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- Provider writes remain idempotent and visible only through their owner.
set role service_role;

insert into public.tracking_events (
  package_id, stage, description, provider_event_id
) values (
  '70000000-0000-0000-0000-000000000007',
  'in_transit',
  'Sorted',
  'provider:event-1'
) on conflict do nothing;

insert into public.tracking_events (
  package_id, stage, description, provider_event_id
) values (
  '70000000-0000-0000-0000-000000000007',
  'in_transit',
  'Sorted again',
  'provider:event-1'
) on conflict do nothing;

do $$
declare
  duplicates integer;
begin
  select count(*) into duplicates
  from public.tracking_events
  where package_id = '70000000-0000-0000-0000-000000000007'
    and provider_event_id = 'provider:event-1';
  if duplicates <> 1 then
    raise exception 'provider event deduplication failed';
  end if;
end;
$$;

insert into public.push_subscriptions (
  id, endpoint, p256dh, auth, subscribed_at
) values (
  '60000000-0000-0000-0000-000000000006',
  'https://push.example.test/device-token',
  'public-encryption-key',
  'auth-secret',
  '2000-01-01T00:00:00Z'
);

-- New events are pending only until each subscribed device is acknowledged.
do $$
declare
  pending integer;
begin
  select count(*) into pending
  from public.pending_push_notifications
  where subscription_id = '60000000-0000-0000-0000-000000000006';
  if pending <> 1 then
    raise exception 'expected one pending provider event, found %', pending;
  end if;
end;
$$;

insert into public.push_deliveries (subscription_id, event_id)
select
  '60000000-0000-0000-0000-000000000006',
  id
from public.tracking_events
where package_id = '70000000-0000-0000-0000-000000000007'
  and provider_event_id = 'provider:event-1';

do $$
begin
  if exists (
    select 1 from public.pending_push_notifications
    where subscription_id = '60000000-0000-0000-0000-000000000006'
  ) then
    raise exception 'acknowledged push event remained pending';
  end if;
end;
$$;

-- Invalid state values are still rejected.
do $$
begin
  begin
    update public.packages
    set current_stage = 'teleported'
    where id = '70000000-0000-0000-0000-000000000007';
    raise exception 'expected current_stage constraint failure';
  exception when check_violation then
    null;
  end;

  begin
    update public.packages
    set sync_status = 'mystery'
    where id = '70000000-0000-0000-0000-000000000007';
    raise exception 'expected sync_status constraint failure';
  exception when check_violation then
    null;
  end;
end;
$$;

-- Archive support retains the parcel and every tracking event.
update public.packages
set archived_at = now()
where id = '70000000-0000-0000-0000-000000000007';

do $$
begin
  if not exists (
    select 1 from public.packages
    where id = '70000000-0000-0000-0000-000000000007'
      and archived_at is not null
  ) then
    raise exception 'soft archive removed or failed to mark the parcel';
  end if;
  if not exists (
    select 1 from public.tracking_events
    where package_id = '70000000-0000-0000-0000-000000000007'
      and provider_event_id = 'provider:event-1'
  ) then
    raise exception 'soft archive removed tracking history';
  end if;
end;
$$;

update public.packages
set archived_at = null
where id = '70000000-0000-0000-0000-000000000007';

reset role;

-- Protect/recovery infrastructure from the original anonymous-account design
-- stays removed from the final schema.
do $$
begin
  if to_regprocedure('public.claim_legacy_packages(text)') is not null then
    raise exception 'legacy recovery function still exists';
  end if;
  if to_regclass('private.delivery_recovery_codes') is not null then
    raise exception 'legacy recovery table still exists';
  end if;
end;
$$;

select 'per-user ownership and RLS assertions passed' as result;
