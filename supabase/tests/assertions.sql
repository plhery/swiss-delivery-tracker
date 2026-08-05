\set ON_ERROR_STOP on

-- The account-owned fixture created before the final migration survived the
-- move to a shared server collection.
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
    raise exception 'existing owner provenance was not preserved';
  end if;
end;
$$;

-- The backend service role owns all CRUD and creates account-independent rows.
set role service_role;

insert into public.packages (
  id, tracking_number, label, carrier
) values (
  '50000000-0000-0000-0000-000000000005',
  'SHARED-TRACKING-2',
  'Shared parcel',
  'planzer'
);

do $$
declare
  visible integer;
begin
  select count(*) into visible from public.packages;
  if visible <> 2 then
    raise exception 'service role could not see the shared collection';
  end if;

  if (select user_id is not null from public.packages where id = '50000000-0000-0000-0000-000000000005') then
    raise exception 'new shared package unexpectedly has an app user owner';
  end if;
end;
$$;

update public.packages
set label = 'Updated everywhere'
where id = '50000000-0000-0000-0000-000000000005';

insert into public.push_subscriptions (
  id, endpoint, p256dh, auth, subscribed_at
) values (
  '60000000-0000-0000-0000-000000000006',
  'https://push.example.test/device-token',
  'public-encryption-key',
  'auth-secret',
  '2000-01-01T00:00:00Z'
);

reset role;

-- Browser Supabase roles no longer have table access; Cloudflare Access plus
-- the application API is the only user-facing path.
set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);

do $$
begin
  begin
    perform count(*) from public.packages;
    raise exception 'expected direct authenticated reads to be denied';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into public.packages (tracking_number) values ('DIRECT-BROWSER-WRITE');
    raise exception 'expected direct authenticated writes to be denied';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform count(*) from public.push_subscriptions;
    raise exception 'expected direct authenticated push subscription reads to be denied';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform count(*) from public.pending_push_notifications;
    raise exception 'expected direct authenticated push queue reads to be denied';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- Global deduplication replaces the old per-auth-user uniqueness rule.
do $$
begin
  begin
    insert into public.packages (tracking_number, carrier)
    values ('SHARED-TRACKING-2', 'planzer');
    raise exception 'expected duplicate shared tracking number to fail';
  exception when unique_violation then
    null;
  end;
end;
$$;

-- Provider events remain idempotent.
insert into public.tracking_events (
  package_id, stage, description, provider_event_id
) values (
  '50000000-0000-0000-0000-000000000005',
  'in_transit',
  'Sorted',
  'provider:event-1'
) on conflict do nothing;

insert into public.tracking_events (
  package_id, stage, description, provider_event_id
) values (
  '50000000-0000-0000-0000-000000000005',
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
  where package_id = '50000000-0000-0000-0000-000000000005'
    and provider_event_id = 'provider:event-1';
  if duplicates <> 1 then
    raise exception 'provider event deduplication failed';
  end if;
end;
$$;

-- New events are pending only until each subscribed device is acknowledged.
set role service_role;

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
where package_id = '50000000-0000-0000-0000-000000000005'
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

reset role;

-- Invalid state values are still rejected.
do $$
begin
  begin
    update public.packages
    set current_stage = 'teleported'
    where id = '50000000-0000-0000-0000-000000000005';
    raise exception 'expected current_stage constraint failure';
  exception when check_violation then
    null;
  end;

  begin
    update public.packages
    set sync_status = 'mystery'
    where id = '50000000-0000-0000-0000-000000000005';
    raise exception 'expected sync_status constraint failure';
  exception when check_violation then
    null;
  end;
end;
$$;

-- Archive support retains the parcel and every tracking event.
set role service_role;
update public.packages
set archived_at = now()
where id = '50000000-0000-0000-0000-000000000005';

do $$
begin
  if not exists (
    select 1 from public.packages
    where id = '50000000-0000-0000-0000-000000000005'
      and archived_at is not null
  ) then
    raise exception 'soft archive removed or failed to mark the parcel';
  end if;
  if not exists (
    select 1 from public.tracking_events
    where package_id = '50000000-0000-0000-0000-000000000005'
      and provider_event_id = 'provider:event-1'
  ) then
    raise exception 'soft archive removed tracking history';
  end if;
end;
$$;

update public.packages
set archived_at = null
where id = '50000000-0000-0000-0000-000000000005';
reset role;

-- Protect/recovery infrastructure is gone from the final schema.
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

select 'shared backend migration assertions passed' as result;
