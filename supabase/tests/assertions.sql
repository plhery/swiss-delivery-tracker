\set ON_ERROR_STOP on

-- The Swiss Post repair must move both the summary and event out of the final
-- state, then schedule the parcel for a fresh carrier check.
do $$
begin
  if not exists (
    select 1
    from public.packages
    where id = '80000000-0000-0000-0000-000000000008'
      and current_stage = 'in_transit'
      and sync_status = 'pending'
      and last_synced_at is null
  ) then
    raise exception 'TO_BE_DELIVERED package was not repaired';
  end if;

  if not exists (
    select 1
    from public.tracking_events
    where package_id = '80000000-0000-0000-0000-000000000008'
      and provider_event_id = 'swiss-post:to-be-delivered-fixture'
      and stage = 'in_transit'
  ) then
    raise exception 'TO_BE_DELIVERED event was not repaired';
  end if;
end;
$$;

delete from public.packages
where id = '80000000-0000-0000-0000-000000000008';

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

-- Authenticated PostgREST clients can read through RLS, but package writes are
-- exposed only through validated, owner-scoped RPCs.
do $$
begin
  if has_table_privilege('authenticated', 'public.packages', 'INSERT')
      or has_table_privilege('authenticated', 'public.packages', 'UPDATE')
      or has_table_privilege('authenticated', 'public.packages', 'DELETE') then
    raise exception 'authenticated retained direct package mutation privileges';
  end if;
  if has_table_privilege('authenticated', 'public.native_push_devices', 'SELECT')
      or has_table_privilege('authenticated', 'public.native_push_devices', 'INSERT')
      or has_table_privilege('authenticated', 'public.native_push_deliveries', 'SELECT')
      or has_table_privilege('anon', 'public.native_push_devices', 'SELECT') then
    raise exception 'public database roles can access native push credentials';
  end if;
  if has_table_privilege('authenticated', 'public.sync_jobs', 'SELECT')
      or has_table_privilege('authenticated', 'public.sync_jobs', 'INSERT')
      or has_table_privilege('anon', 'public.sync_jobs', 'SELECT')
      or has_function_privilege(
        'authenticated',
        'public.claim_sync_job(text,integer)',
        'EXECUTE'
      ) then
    raise exception 'public database roles can access the durable worker queue';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.create_owned_package(text,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot execute the validated package RPC';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.set_owned_notification_preferences(text[],time,time,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.set_owned_package_notifications_muted(uuid,boolean)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.delete_owned_archived_package(uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.delete_owned_package(uuid)',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot execute notification preference RPCs';
  end if;
end;
$$;

-- The first user sees only their parcel, can create another parcel with the
-- same tracking number as another user, and cannot alter server-owned fields.
set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);

do $$
declare
  deletable_id uuid;
begin
  select id into deletable_id
  from public.create_owned_package('DELETEDIRECT01', 'Direct delete test', 'unknown', null, null);

  if not public.delete_owned_package(deletable_id) then
    raise exception 'an owner could not permanently delete an active package';
  end if;
  if exists (select 1 from public.packages where id = deletable_id)
    or exists (select 1 from public.tracking_events where package_id = deletable_id) then
    raise exception 'direct permanent deletion did not cascade through package history';
  end if;
end;
$$;

do $$
declare
  visible integer;
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

  begin
    update public.packages
    set label = 'Cross-tenant update'
    where id = '70000000-0000-0000-0000-000000000007';
    raise exception 'authenticated user retained direct package update access';
  exception when insufficient_privilege then
    null;
  end;

  begin
    delete from public.packages
    where id = '70000000-0000-0000-0000-000000000007';
    raise exception 'authenticated user retained direct package delete access';
  exception when insufficient_privilege then
    null;
  end;

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

select public.create_owned_package(
  'CROSSTENANT9', 'Same number, first owner', 'planzer', null, null
);

select public.create_owned_package(
  '06086514587082', 'Verified DPD parcel', 'dpd', null, '8004'
);

select public.create_owned_package(
  '9010000001234',
  'Dachser parcel',
  'dachser',
  'https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?cliente=generico&numeroUnico=9010000001234&fecha=20260513&clave=TESTKEY9',
  null
);

select public.create_owned_package(
  '9010000005678',
  'Dachser parcel with maximum key length',
  'dachser',
  'https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?numeroUnico=9010000005678&hash=' || repeat('A', 256),
  null
);

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
    perform public.create_owned_package(
      'CROSSTENANT9', '', 'planzer', null, null
    );
    raise exception 'same-user duplicate tracking number was accepted';
  exception when unique_violation then
    null;
  end;

  if not exists (
    select 1 from public.packages
    where tracking_number = '06086514587082'
      and dpd_postcode = '8004'
      and user_id = '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'DPD postcode was not stored for its owner';
  end if;

  if not exists (
    select 1 from public.packages
    where tracking_number = '9010000001234'
      and carrier = 'dachser'
      and tracking_url like 'https://customeriberia.dachser.com/%'
      and user_id = '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Dachser capability URL was not stored for its owner';
  end if;

  begin
    perform public.create_owned_package(
      '9010000001235', '', 'dachser', null, null
    );
    raise exception 'Dachser package without a capability URL was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      '9010000001235',
      '',
      'dachser',
      'https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?numeroUnico=9010000009999&fecha=20260513&clave=TESTKEY9',
      null
    );
    raise exception 'Dachser URL for a different shipment was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      '06086514587083', '', 'dpd', null, '80A4'
    );
    raise exception 'invalid DPD postcode was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      'NOTDPD8004', '', 'dhl', null, '8004'
    );
    raise exception 'DPD postcode was accepted for a different carrier';
  exception when invalid_parameter_value then
    null;
  end;

  if not public.rename_owned_package(
    (select id from public.packages where tracking_number = 'CROSSTENANT9'),
    'Renamed through RPC'
  ) then
    raise exception 'owner could not rename a package through the RPC';
  end if;

  if not public.set_owned_package_archived(
    (select id from public.packages where tracking_number = '06086514587082'),
    true
  ) or not public.set_owned_package_archived(
    (select id from public.packages where tracking_number = '06086514587082'),
    false
  ) then
    raise exception 'owner could not archive and restore a package through the RPC';
  end if;

  perform public.set_owned_notification_preferences(
    array['customs', 'out_for_delivery', 'delivered'],
    '22:00',
    '08:00',
    'Europe/Zurich'
  );
  if not exists (
    select 1 from public.notification_preferences
    where user_id = '10000000-0000-0000-0000-000000000001'
      and enabled_stages = array['customs', 'out_for_delivery', 'delivered']
      and quiet_hours_start = '22:00'
      and quiet_hours_end = '08:00'
  ) then
    raise exception 'owner notification preferences were not stored';
  end if;

  if not public.set_owned_package_notifications_muted(
    (select id from public.packages where tracking_number = 'CROSSTENANT9'),
    true
  ) then
    raise exception 'owner could not mute package notifications';
  end if;
  if not exists (
    select 1 from public.packages
    where tracking_number = 'CROSSTENANT9'
      and notifications_muted
  ) then
    raise exception 'package notification mute was not stored';
  end if;

  begin
    update public.notification_preferences
    set timezone = 'UTC';
    raise exception 'authenticated user retained direct preference update access';
  exception when insufficient_privilege then
    null;
  end;

  begin
    update public.packages
    set dpd_postcode = '3000'
    where tracking_number = '06086514587082';
    raise exception 'authenticated user changed a stored DPD postcode';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

do $$
declare
  deletable_id uuid;
begin
  select id into deletable_id
  from public.create_owned_package('DELETEARCHIVE1', 'Delete test', 'unknown', null, null);

  if public.delete_owned_archived_package(deletable_id) then
    raise exception 'an active package was permanently deleted';
  end if;
  perform public.set_owned_package_archived(deletable_id, true);
  if not public.delete_owned_archived_package(deletable_id) then
    raise exception 'an owner could not permanently delete an archived package';
  end if;
  if exists (select 1 from public.packages where id = deletable_id)
    or exists (select 1 from public.tracking_events where package_id = deletable_id) then
    raise exception 'permanent deletion did not cascade through package history';
  end if;
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
  if exists (
    select 1 from public.packages
    where tracking_number = '06086514587082'
      and dpd_postcode = '8004'
  ) then
    raise exception 'second user could see first-user DPD verification data';
  end if;
  if public.rename_owned_package(
    '40000000-0000-0000-0000-000000000004',
    'Cross-tenant rename'
  ) then
    raise exception 'second user renamed a first-user package through the RPC';
  end if;
  if public.set_owned_package_archived(
    '40000000-0000-0000-0000-000000000004',
    true
  ) then
    raise exception 'second user archived a first-user package through the RPC';
  end if;
  if public.set_owned_package_notifications_muted(
    '40000000-0000-0000-0000-000000000004',
    true
  ) then
    raise exception 'second user muted a first-user package through the RPC';
  end if;
  if public.delete_owned_archived_package(
    '40000000-0000-0000-0000-000000000004'
  ) then
    raise exception 'second user deleted a first-user archived package through the RPC';
  end if;
  if public.delete_owned_package(
    '40000000-0000-0000-0000-000000000004'
  ) then
    raise exception 'second user directly deleted a first-user package through the RPC';
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

-- NOT VALID ownership checks preserve the known pre-auth rows, but still
-- reject every new ownerless record, including service-role mistakes.
do $$
begin
  if not exists (
    select 1 from public.packages
    where id = '50000000-0000-0000-0000-000000000005'
      and user_id is null
  ) then
    raise exception 'legacy ownerless parcel did not survive the cutover constraint';
  end if;

  begin
    insert into public.packages (user_id, tracking_number, label, carrier)
    values (null, 'OWNERLESS99', 'Must be rejected', 'planzer');
    raise exception 'new ownerless package was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.push_subscriptions (endpoint, p256dh, auth)
    values ('https://fcm.googleapis.com/fcm/send/ownerless', 'public-key', 'auth-secret');
    raise exception 'new ownerless push subscription was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values (
      '10000000-0000-0000-0000-000000000001',
      'https://attacker.example/internal',
      'public-key',
      'auth-secret'
    );
    raise exception 'an arbitrary push endpoint was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

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

update public.packages
set expected_delivery = '2099-01-02'
where id = '70000000-0000-0000-0000-000000000007';

do $$
declare
  changed_at timestamptz;
begin
  select expected_delivery_changed_at into changed_at
  from public.packages
  where id = '70000000-0000-0000-0000-000000000007';

  if changed_at is null then
    raise exception 'delivery estimate change was not timestamped';
  end if;

  update public.packages
  set expected_delivery = '2099-01-02'
  where id = '70000000-0000-0000-0000-000000000007';

  if (
    select expected_delivery_changed_at
    from public.packages
    where id = '70000000-0000-0000-0000-000000000007'
  ) is distinct from changed_at then
    raise exception 'unchanged delivery estimate was marked as new';
  end if;
end;
$$;

insert into public.push_subscriptions (
  id, user_id, endpoint, p256dh, auth, subscribed_at
) values (
  '60000000-0000-0000-0000-000000000006',
  '20000000-0000-0000-0000-000000000002',
  'https://fcm.googleapis.com/fcm/send/device-token',
  'public-encryption-key',
  'auth-secret',
  '2000-01-01T00:00:00Z'
);

insert into public.native_push_devices (
  id, user_id, token, environment, locale, device_name, subscribed_at
) values (
  'a0000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  repeat('ab', 32),
  'development',
  'de',
  'Test iPhone',
  '2000-01-01T00:00:00Z'
), (
  'a0000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  repeat('cd', 32),
  'production',
  'fr',
  null,
  '2000-01-01T00:00:00Z'
);

-- Routine app launches update device metadata without advancing the delivery
-- cursor.
update public.native_push_devices
set locale = 'it', subscribed_at = now()
where id = 'a0000000-0000-0000-0000-000000000001';

do $$
begin
  if (
    select subscribed_at
    from public.native_push_devices
    where id = 'a0000000-0000-0000-0000-000000000001'
  ) <> '2000-01-01T00:00:00Z'::timestamptz then
    raise exception 'routine APNs token refresh advanced its delivery cursor';
  end if;
  if (
    select locale
    from public.native_push_devices
    where id = 'a0000000-0000-0000-0000-000000000001'
  ) <> 'it' then
    raise exception 'routine APNs metadata refresh was not applied';
  end if;
end;
$$;

insert into public.push_subscriptions (
  id, user_id, endpoint, p256dh, auth, subscribed_at
) values (
  '80000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'https://fcm.googleapis.com/fcm/send/first-owner-device',
  'first-owner-public-key',
  'first-owner-auth-secret',
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

  if not exists (
    select 1
    from public.pending_push_notifications
    where subscription_id = '60000000-0000-0000-0000-000000000006'
      and expected_delivery = '2099-01-02'
      and expected_delivery_changed
      and timezone = 'Europe/Zurich'
  ) then
    raise exception 'browser push queue omitted the changed delivery estimate';
  end if;

  if exists (
    select 1
    from public.pending_push_notifications
    where subscription_id = '80000000-0000-0000-0000-000000000008'
      and package_id = '70000000-0000-0000-0000-000000000007'
  ) then
    raise exception 'first user received a second-user push event';
  end if;

  select count(*) into pending
  from public.pending_native_push_notifications
  where device_id = 'a0000000-0000-0000-0000-000000000001';
  if pending <> 1 then
    raise exception 'expected one pending native event, found %', pending;
  end if;

  if not exists (
    select 1
    from public.pending_native_push_notifications
    where device_id = 'a0000000-0000-0000-0000-000000000001'
      and expected_delivery = '2099-01-02'
      and expected_delivery_changed
      and timezone = 'Europe/Zurich'
  ) then
    raise exception 'native push queue omitted the changed delivery estimate';
  end if;

  if exists (
    select 1
    from public.pending_native_push_notifications
    where device_id = 'a0000000-0000-0000-0000-000000000002'
      and package_id = '70000000-0000-0000-0000-000000000007'
  ) then
    raise exception 'first user received a second-user native push event';
  end if;
end;
$$;

-- A genuinely disabled device starts a fresh cursor when it returns. This is
-- checked only after the cross-account assertion above has exercised the old
-- cursor against the second owner's event.
update public.native_push_devices
set disabled_at = now()
where id = 'a0000000-0000-0000-0000-000000000002';

update public.native_push_devices
set disabled_at = null, subscribed_at = '2000-01-01T00:00:00Z'
where id = 'a0000000-0000-0000-0000-000000000002';

do $$
begin
  if (
    select subscribed_at
    from public.native_push_devices
    where id = 'a0000000-0000-0000-0000-000000000002'
  ) < now() - interval '1 minute' then
    raise exception 're-enabled APNs token retained a stale delivery cursor';
  end if;
end;
$$;

-- Account event filters and parcel mutes remove notifications from every
-- device queue without acknowledging or deleting the carrier event.
insert into public.notification_preferences (user_id, enabled_stages)
values (
  '20000000-0000-0000-0000-000000000002',
  array['delivered']
);

do $$
begin
  if exists (
    select 1 from public.pending_push_notifications
    where subscription_id = '60000000-0000-0000-0000-000000000006'
  ) then
    raise exception 'disabled notification stage remained pending';
  end if;
  if exists (
    select 1 from public.pending_native_push_notifications
    where device_id = 'a0000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'disabled notification stage remained pending for APNs';
  end if;
end;
$$;

update public.notification_preferences
set enabled_stages = array[
  'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery',
  'failed_attempt', 'ready_for_pickup', 'delivered', 'returned'
]
where user_id = '20000000-0000-0000-0000-000000000002';

update public.packages
set notifications_muted = true
where id = '70000000-0000-0000-0000-000000000007';

do $$
begin
  if exists (
    select 1 from public.pending_push_notifications
    where subscription_id = '60000000-0000-0000-0000-000000000006'
  ) then
    raise exception 'muted parcel event remained pending';
  end if;
  if exists (
    select 1 from public.pending_native_push_notifications
    where device_id = 'a0000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'muted parcel event remained pending for APNs';
  end if;
end;
$$;

update public.packages
set notifications_muted = false
where id = '70000000-0000-0000-0000-000000000007';

insert into public.push_deliveries (subscription_id, event_id)
select
  '60000000-0000-0000-0000-000000000006',
  id
from public.tracking_events
where package_id = '70000000-0000-0000-0000-000000000007'
  and provider_event_id = 'provider:event-1';

insert into public.native_push_deliveries (device_id, event_id)
select
  'a0000000-0000-0000-0000-000000000001',
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
  if exists (
    select 1 from public.pending_native_push_notifications
    where device_id = 'a0000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'acknowledged native push event remained pending';
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

-- Quotas are serialized and enforced even when a client bypasses the app and
-- calls PostgREST RPCs directly.
insert into auth.users (id, email)
values (
  '90000000-0000-0000-0000-000000000009',
  'quota-owner@example.invalid'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000009', false);

do $$
declare
  item integer;
  quota_blocked boolean := false;
  restore_blocked boolean := false;
begin
  for item in 1..50 loop
    perform public.create_owned_package(
      'QUOTA' || lpad(item::text, 4, '0'),
      '',
      'unknown',
      null,
      null
    );
  end loop;

  begin
    perform public.create_owned_package('QUOTA0051', '', 'unknown', null, null);
  exception when sqlstate 'P0001' then
    quota_blocked := true;
  end;
  if not quota_blocked then
    raise exception 'the active-package quota was not enforced' using errcode = 'P0002';
  end if;

  -- An idempotent restore does not increase the active count and remains valid
  -- when the account is already at the limit.
  perform public.set_owned_package_archived(
    (select id from public.packages where tracking_number = 'QUOTA0002'),
    false
  );

  -- Free one active slot and consume it with another parcel. Restoring the
  -- archived parcel must not create a 51st active parcel.
  perform public.set_owned_package_archived(
    (select id from public.packages where tracking_number = 'QUOTA0001'),
    true
  );
  perform public.create_owned_package('QUOTA0051', '', 'unknown', null, null);

  begin
    perform public.set_owned_package_archived(
      (select id from public.packages where tracking_number = 'QUOTA0001'),
      false
    );
  exception when sqlstate 'P0001' then
    restore_blocked := true;
  end;
  if not restore_blocked then
    raise exception 'the restore quota was not enforced' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.packages
    where tracking_number = 'QUOTA0001' and archived_at is not null
  ) then
    raise exception 'a quota-blocked restore changed the parcel' using errcode = 'P0002';
  end if;

  -- Once a slot is available, restoring the archived parcel succeeds.
  perform public.set_owned_package_archived(
    (select id from public.packages where tracking_number = 'QUOTA0051'),
    true
  );
  perform public.set_owned_package_archived(
    (select id from public.packages where tracking_number = 'QUOTA0001'),
    false
  );
  if not exists (
    select 1 from public.packages
    where tracking_number = 'QUOTA0001' and archived_at is null
  ) then
    raise exception 'restore failed after an active slot became available' using errcode = 'P0002';
  end if;
end;
$$;

reset role;
delete from auth.users where id = '90000000-0000-0000-0000-000000000009';

-- Durable jobs deduplicate while active, are claimed atomically by the service
-- role, and release their key when complete so a later refresh can be queued.
set role service_role;

insert into public.sync_jobs (
  id, user_id, package_id, kind, dedupe_key, priority
) values (
  '42000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000004',
  'package',
  'package:40000000-0000-0000-0000-000000000004',
  10
);

insert into public.sync_jobs (user_id, package_id, kind, dedupe_key, priority)
values (
  '10000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000004',
  'package',
  'package:40000000-0000-0000-0000-000000000004',
  10
)
on conflict (dedupe_key) do nothing;

do $$
declare
  claimed public.sync_jobs;
begin
  if (
    select count(*) from public.sync_jobs
    where dedupe_key = 'package:40000000-0000-0000-0000-000000000004'
  ) <> 1 then
    raise exception 'active sync jobs were not deduplicated';
  end if;

  select * into claimed from public.claim_sync_job('migration-test-worker', 300);
  if claimed.id <> '42000000-0000-0000-0000-000000000004'::uuid
      or claimed.state <> 'running'
      or claimed.locked_by <> 'migration-test-worker'
      or claimed.attempts <> 1
      or claimed.lease_until is null then
    raise exception 'durable sync job was not leased correctly';
  end if;

  update public.sync_jobs
  set
    state = 'succeeded',
    completed_at = now(),
    locked_by = null,
    lease_until = null,
    dedupe_key = null,
    result = '{"checked":1}'::jsonb
  where id = claimed.id and locked_by = 'migration-test-worker';

  if not exists (
    select 1 from public.sync_jobs
    where id = claimed.id
      and state = 'succeeded'
      and dedupe_key is null
      and result = '{"checked":1}'::jsonb
  ) then
    raise exception 'completed sync job did not retain its safe result';
  end if;
end;
$$;

reset role;

select 'per-user ownership and RLS assertions passed' as result;
