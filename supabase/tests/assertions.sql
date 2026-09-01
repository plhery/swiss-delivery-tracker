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

-- India-issued S10 shipments leave the generic fallback with stale state and
-- in-flight work cleared before the normal automatic scheduler picks them up.
do $$
begin
  if not exists (
    select 1
    from public.packages
    where id = '81000000-0000-0000-0000-000000000081'
      and carrier = 'india-post'
      and current_stage = 'pending'
      and sync_status = 'pending'
      and last_synced_at is null
      and carrier_data = '{}'::jsonb
  ) then
    raise exception 'existing India Post package was not migrated';
  end if;

  if exists (
    select 1
    from public.tracking_events
    where package_id = '81000000-0000-0000-0000-000000000081'
      and provider_event_id <> 'app:pending'
  ) or not exists (
    select 1
    from public.tracking_events
    where package_id = '81000000-0000-0000-0000-000000000081'
      and provider_event_id = 'app:pending'
      and stage = 'pending'
  ) then
    raise exception 'India Post migration retained stale tracking events';
  end if;

  if not exists (
    select 1
    from public.sync_jobs
    where id = '82000000-0000-0000-0000-000000000082'
      and state = 'failed'
      and dedupe_key is null
      and completed_at is not null
  ) then
    raise exception 'India Post migration retained stale sync work';
  end if;
end;
$$;

delete from public.packages
where id = '81000000-0000-0000-0000-000000000081';

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
  if has_table_privilege('authenticated', 'public.live_activity_devices', 'SELECT')
      or has_table_privilege('authenticated', 'public.live_activity_devices', 'INSERT')
      or has_table_privilege('authenticated', 'public.live_activity_update_tokens', 'SELECT')
      or has_table_privilege('authenticated', 'public.live_activity_event_deliveries', 'SELECT')
      or has_table_privilege('anon', 'public.pending_live_activity_events', 'SELECT') then
    raise exception 'public database roles can access ActivityKit credentials';
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
  if has_table_privilege('authenticated', 'public.tracking_sync_attempts', 'SELECT')
      or has_table_privilege('authenticated', 'public.tracking_sync_steps', 'SELECT')
      or has_table_privilege('anon', 'public.tracking_sync_attempts', 'SELECT')
      or has_table_privilege('anon', 'public.tracking_sync_recent_anomalies', 'SELECT')
      or has_function_privilege(
        'authenticated',
        'public.complete_tracking_sync_attempt(uuid,jsonb,jsonb)',
        'EXECUTE'
      )
      or has_function_privilege(
        'authenticated',
        'public.maintain_tracking_sync_audit()',
        'EXECUTE'
      ) then
    raise exception 'public database roles can access the private tracking audit';
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
    'public.change_owned_package_carrier(uuid,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot change an owned package carrier';
  end if;
  if has_function_privilege(
    'anon',
    'public.change_owned_package_carrier(uuid,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.change_owned_package_carrier(uuid,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'non-user roles can change an owned package carrier';
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
  '250123456789012', 'DPD France parcel', 'dpd-fr', null, null
);

select public.create_owned_package(
  '76434219', 'Mondial Relay parcel', 'mondial-relay', null, '59650'
);

select public.create_owned_package(
  'CC200000000401', 'Relais Colis parcel', 'relais-colis', null, null
);

select public.create_owned_package(
  '8G12345678901', 'French postal parcel', 'la-poste', null, null
);

select public.create_owned_package(
  'PZ123456785JF', 'Chronopost parcel', 'chronopost', null, null
);

select public.create_owned_package(
  '00AB12CD', 'GLS France parcel', 'gls-fr', null, null
);

select public.create_owned_package(
  '99112233445575012', 'Colis Prive parcel', 'colis-prive', null, null
);

select public.create_owned_package(
  '1G1234567890', 'GEODIS parcel', 'geodis', null, null
);

select public.create_owned_package(
  '1234ABC789', 'Swiss Post Cargo shipment', 'swiss-post-cargo', null, null
);

select public.create_owned_package(
  '993990103198', 'GLS Switzerland parcel', 'gls-ch', null, '8000'
);

select public.create_owned_package(
  '12345678', 'Colisweb delivery', 'colisweb', null, null
);

select public.create_owned_package(
  'FGRC45BKLM', 'C Chez Vous delivery', 'c-chez-vous', null, null
);

select public.create_owned_package(
  '23456789', 'Heppner shipment', 'heppner', null, '75001'
);

select public.create_owned_package(
  '12345678901234', 'Ciblex parcel', 'ciblex', null, null
);

select public.create_owned_package(
  'PAACK12345', 'Paack delivery', 'paack', null, '1234-567'
);

select public.create_owned_package(
  'ASE12345678', 'Asendia parcel link', 'asendia', null, null
);

select public.create_owned_package(
  'RR000000005IN', 'India Post parcel', 'india-post', null, null
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
    where tracking_number = '76434219'
      and dpd_postcode = '59650'
      and user_id = '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Mondial Relay postcode was not stored for its owner';
  end if;

  if not exists (
    select 1 from public.packages
    where tracking_number = '993990103198'
      and carrier = 'gls-ch'
      and dpd_postcode = '8000'
      and user_id = '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'GLS Switzerland postcode was not stored for its owner';
  end if;

  if not exists (
    select 1 from public.packages
    where tracking_number = '23456789'
      and carrier = 'heppner'
      and dpd_postcode = '75001'
      and user_id = '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Heppner postcode was not stored for its owner';
  end if;

  if not exists (
    select 1 from public.packages
    where tracking_number = 'PAACK12345'
      and carrier = 'paack'
      and dpd_postcode = '1234-567'
      and user_id = '10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Paack postcode was not stored for its owner';
  end if;

  begin
    perform public.create_owned_package(
      'PAACK12346', '', 'paack', null, '12 - 345'
    );
    raise exception 'Paack postcode with doubled separators was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  if (
    select count(*)
    from public.packages
    where user_id = '10000000-0000-0000-0000-000000000001'
      and (tracking_number, carrier) in (
        ('250123456789012', 'dpd-fr'),
        ('76434219', 'mondial-relay'),
        ('CC200000000401', 'relais-colis'),
        ('8G12345678901', 'la-poste'),
        ('PZ123456785JF', 'chronopost'),
        ('00AB12CD', 'gls-fr'),
        ('99112233445575012', 'colis-prive'),
        ('1G1234567890', 'geodis')
      )
  ) <> 8 then
    raise exception 'French carrier identifiers were not accepted by the package RPC';
  end if;

  if (
    select count(*)
    from public.packages
    where user_id = '10000000-0000-0000-0000-000000000001'
      and (tracking_number, carrier) in (
        ('1234ABC789', 'swiss-post-cargo'),
        ('993990103198', 'gls-ch'),
        ('12345678', 'colisweb'),
        ('FGRC45BKLM', 'c-chez-vous'),
        ('23456789', 'heppner'),
        ('12345678901234', 'ciblex'),
        ('PAACK12345', 'paack'),
        ('ASE12345678', 'asendia'),
        ('RR000000005IN', 'india-post')
      )
  ) <> 9 then
    raise exception 'regional carrier identifiers were not accepted by the package RPC';
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
    raise exception 'delivery postcode was accepted for a different carrier';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      '76434220', '', 'mondial-relay', null, '5965'
    );
    raise exception 'invalid Mondial Relay postcode was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      '993990103199', '', 'gls-ch', null, '800'
    );
    raise exception 'invalid GLS Switzerland postcode was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      '23456790', '', 'heppner', null, '750010'
    );
    raise exception 'invalid Heppner postcode was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      'PAACK12346', '', 'paack', null, '12--345'
    );
    raise exception 'invalid Paack postcode was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.create_owned_package(
      'PAACK12347', '', 'paack', null, 'ABC'
    );
    raise exception 'all-letter Paack postcode was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  if not public.rename_owned_package(
    (select id from public.packages where tracking_number = 'CROSSTENANT9'),
    'Renamed through RPC'
  ) then
    raise exception 'owner could not rename a package through the RPC';
  end if;

  if not public.change_owned_package_carrier(
    (select id from public.packages where tracking_number = 'CROSSTENANT9'),
    'amazon-logistics',
    null,
    null
  ) then
    raise exception 'owner could not change a package carrier through the RPC';
  end if;
  if not exists (
    select 1 from public.packages
    where tracking_number = 'CROSSTENANT9'
      and carrier = 'amazon-logistics'
      and current_stage = 'pending'
      and expected_delivery is null
      and last_status_text is null
      and sync_status = 'pending'
      and carrier_data = '{}'::jsonb
  ) or exists (
    select 1 from public.tracking_events
    where package_id = (
      select id from public.packages where tracking_number = 'CROSSTENANT9'
    )
      and provider_event_id is distinct from 'app:pending'
  ) then
    raise exception 'changing a carrier did not reset stale tracking state';
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
  if public.change_owned_package_carrier(
    '40000000-0000-0000-0000-000000000004',
    'ups',
    null,
    null
  ) then
    raise exception 'second user changed a first-user package carrier through the RPC';
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

-- Delivery-day activities start only when a parcel goes out for delivery,
-- continue through the per-activity update token, and end on a terminal event.
-- A successful ActivityKit delivery is also visible to the matching native
-- device so the ordinary alert dispatcher can avoid duplicate banners.
update public.native_push_devices
set installation_id = 'd0000000-0000-0000-0000-000000000001'
where id = 'a0000000-0000-0000-0000-000000000001';

insert into public.live_activity_devices (
  id, user_id, installation_id, token, environment, locale, subscribed_at
) values (
  'c0000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-000000000001',
  repeat('ef', 32),
  'development',
  'de',
  '2000-01-01T00:00:00Z'
);

do $$
begin
  if exists (
    select 1
    from public.pending_live_activity_events
    where device_id = 'c0000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'a Live Activity started before out for delivery';
  end if;
end;
$$;

insert into public.packages (
  id, user_id, tracking_number, label, carrier, current_stage, expected_delivery
) values (
  '71000000-0000-0000-0000-000000000008',
  '20000000-0000-0000-0000-000000000002',
  'LIVEACTIVITY8',
  'Later delivery',
  'planzer',
  'out_for_delivery',
  '2099-01-03'
), (
  '72000000-0000-0000-0000-000000000009',
  '20000000-0000-0000-0000-000000000002',
  'LIVEACTIVITY9',
  'Latest delivery',
  'planzer',
  'out_for_delivery',
  '2099-01-04'
);

insert into public.tracking_events (
  id, package_id, stage, description, provider_event_id
) values (
  'b4000000-0000-0000-0000-000000000004',
  '71000000-0000-0000-0000-000000000008',
  'out_for_delivery',
  'Later courier is on the way',
  'provider:live-cap-1'
), (
  'b5000000-0000-0000-0000-000000000005',
  '72000000-0000-0000-0000-000000000009',
  'out_for_delivery',
  'Latest courier is on the way',
  'provider:live-cap-2'
);

update public.packages
set current_stage = 'out_for_delivery'
where id = '70000000-0000-0000-0000-000000000007';

insert into public.tracking_events (
  id, package_id, stage, description, provider_event_id
) values (
  'b1000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000007',
  'out_for_delivery',
  'Courier is on the way',
  'provider:live-start'
);

do $$
begin
  if (
    select count(*)
    from public.pending_live_activity_events
    where device_id = 'c0000000-0000-0000-0000-000000000001'
  ) <> 2 then
    raise exception 'Live Activity queue did not cap delivery-day starts at two';
  end if;
  if not exists (
    select 1
    from public.pending_live_activity_events
    where device_id = 'c0000000-0000-0000-0000-000000000001'
      and event_id = 'b1000000-0000-0000-0000-000000000001'
      and update_token is null
      and stage = 'out_for_delivery'
  ) then
    raise exception 'out-for-delivery event did not queue a push-to-start activity';
  end if;
  if exists (
    select 1
    from public.pending_live_activity_events
    where device_id = 'c0000000-0000-0000-0000-000000000001'
      and package_id = '72000000-0000-0000-0000-000000000009'
  ) then
    raise exception 'Live Activity queue included a third delivery-day parcel';
  end if;
end;
$$;

insert into public.live_activity_event_deliveries (
  device_id, event_id, package_id, delivery_kind, event_created_at
)
select
  'c0000000-0000-0000-0000-000000000001',
  id,
  package_id,
  'start',
  created_at
from public.tracking_events
where id = 'b1000000-0000-0000-0000-000000000001';

do $$
begin
  if not exists (
    select 1
    from public.pending_native_push_notifications
    where device_id = 'a0000000-0000-0000-0000-000000000001'
      and event_id = 'b1000000-0000-0000-0000-000000000001'
      and installation_id = 'd0000000-0000-0000-0000-000000000001'
      and live_activity_delivered
  ) then
    raise exception 'native queue did not expose the matching Live Activity delivery';
  end if;
end;
$$;

insert into public.live_activity_update_tokens (
  id, device_id, package_id, activity_id, token, environment, locale, started_at
)
select
  'c1000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000001',
  package_id,
  'activity-1',
  repeat('12', 32),
  'development',
  'de',
  created_at
from public.tracking_events
where id = 'b1000000-0000-0000-0000-000000000001';

update public.live_activity_update_tokens
set locale = 'it', started_at = '2100-01-01T00:00:00Z'
where id = 'c1000000-0000-0000-0000-000000000001';

do $$
begin
  if (
    select started_at
    from public.live_activity_update_tokens
    where id = 'c1000000-0000-0000-0000-000000000001'
  ) is distinct from (
    select created_at
    from public.tracking_events
    where id = 'b1000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'routine Live Activity token refresh advanced its event cursor';
  end if;
  if (
    select locale
    from public.live_activity_update_tokens
    where id = 'c1000000-0000-0000-0000-000000000001'
  ) <> 'it' then
    raise exception 'routine Live Activity token metadata refresh was not applied';
  end if;
end;
$$;

insert into public.tracking_events (
  id, package_id, stage, description, provider_event_id
) values (
  'b2000000-0000-0000-0000-000000000002',
  '70000000-0000-0000-0000-000000000007',
  'out_for_delivery',
  'Two stops away',
  'provider:live-update'
);

do $$
begin
  if not exists (
    select 1
    from public.pending_live_activity_events
    where device_id = 'c0000000-0000-0000-0000-000000000001'
      and event_id = 'b2000000-0000-0000-0000-000000000002'
      and update_token_id = 'c1000000-0000-0000-0000-000000000001'
      and activity_id = 'activity-1'
  ) then
    raise exception 'an active Live Activity did not receive its update event';
  end if;
end;
$$;

insert into public.live_activity_event_deliveries (
  device_id, event_id, package_id, delivery_kind, event_created_at
)
select
  'c0000000-0000-0000-0000-000000000001',
  id,
  package_id,
  'update',
  created_at
from public.tracking_events
where id = 'b2000000-0000-0000-0000-000000000002';

update public.packages
set current_stage = 'delivered'
where id = '70000000-0000-0000-0000-000000000007';

insert into public.tracking_events (
  id, package_id, stage, description, provider_event_id
) values (
  'b3000000-0000-0000-0000-000000000003',
  '70000000-0000-0000-0000-000000000007',
  'delivered',
  'Delivered',
  'provider:live-end'
);

do $$
begin
  if not exists (
    select 1
    from public.pending_live_activity_events
    where device_id = 'c0000000-0000-0000-0000-000000000001'
      and event_id = 'b3000000-0000-0000-0000-000000000003'
      and update_token_id = 'c1000000-0000-0000-0000-000000000001'
      and stage = 'delivered'
  ) then
    raise exception 'terminal event did not queue an end for the active Live Activity';
  end if;
end;
$$;

insert into public.live_activity_devices (
  user_id, installation_id, token, environment, locale
) values (
  '10000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001',
  repeat('34', 32),
  'production',
  'fr'
)
on conflict (installation_id) do update set
  user_id = excluded.user_id,
  token = excluded.token,
  environment = excluded.environment,
  locale = excluded.locale,
  disabled_at = null;

do $$
begin
  if (
    select user_id
    from public.live_activity_devices
    where installation_id = 'd0000000-0000-0000-0000-000000000001'
  ) <> '10000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'Live Activity installation did not move to its current account';
  end if;
  if exists (
    select 1
    from public.live_activity_update_tokens
    where device_id = 'c0000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1
    from public.live_activity_event_deliveries
    where device_id = 'c0000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Live Activity state survived an account rebind';
  end if;
  if (
    select subscribed_at
    from public.live_activity_devices
    where id = 'c0000000-0000-0000-0000-000000000001'
  ) < now() - interval '1 minute' then
    raise exception 'Live Activity account rebind retained a stale delivery cursor';
  end if;
  begin
    insert into public.live_activity_update_tokens (
      device_id, package_id, activity_id, token, environment, locale
    ) values (
      'c0000000-0000-0000-0000-000000000001',
      '70000000-0000-0000-0000-000000000007',
      'cross-account-activity',
      repeat('56', 32),
      'production',
      'fr'
    );
    raise exception 'a Live Activity token crossed account ownership';
  exception when check_violation then
    null;
  end;
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

-- A completed refresh retains every decision step, appears in the private
-- health/anomaly projections, and stale/crashed audit data is maintained.
set role service_role;

insert into public.tracking_sync_attempts (
  id,
  job_id,
  package_id,
  trigger,
  configured_carrier,
  previous_stage,
  started_at
) values (
  '43000000-0000-0000-0000-000000000004',
  '42000000-0000-0000-0000-000000000004',
  '40000000-0000-0000-0000-000000000004',
  'package',
  'dpd-fr',
  'pending',
  now() - interval '2 seconds'
);

do $$
declare
  completed boolean;
begin
  select public.complete_tracking_sync_attempt(
    '43000000-0000-0000-0000-000000000004',
    jsonb_build_object(
      'outcome', 'updated',
      'source_carrier', 'dpd-fr',
      'provider_status', 'delivered',
      'reported_stage', 'delivered',
      'selected_stage', 'delivered',
      'status_text', 'Livré',
      'events_received', 2,
      'events_normalized', 1,
      'anomaly_codes', jsonb_build_array('invalid_event_timestamp'),
      'completed_at', now(),
      'duration_ms', 2000
    ),
    jsonb_build_array(
      jsonb_build_object(
        'sequence', 1,
        'step', 'fetch',
        'status', 'succeeded',
        'occurred_at', now(),
        'duration_ms', 125,
        'details', jsonb_build_object('source_carrier', 'dpd-fr')
      ),
      jsonb_build_object(
        'sequence', 2,
        'step', 'normalize',
        'status', 'succeeded',
        'occurred_at', now(),
        'duration_ms', 2,
        'details', jsonb_build_object('events_normalized', 1)
      ),
      jsonb_build_object(
        'sequence', 3,
        'step', 'complete',
        'status', 'succeeded',
        'occurred_at', now(),
        'duration_ms', 2000,
        'details', jsonb_build_object('outcome', 'updated')
      )
    )
  ) into completed;

  if not completed then
    raise exception 'tracking audit attempt was not completed';
  end if;
  if not exists (
    select 1
    from public.tracking_sync_attempts
    where id = '43000000-0000-0000-0000-000000000004'
      and outcome = 'updated'
      and source_carrier = 'dpd-fr'
      and provider_status = 'delivered'
      and selected_stage = 'delivered'
      and status_text = 'Livré'
      and events_received = 2
      and events_normalized = 1
      and anomaly_codes = array['invalid_event_timestamp']
  ) then
    raise exception 'tracking audit did not retain its classification decision';
  end if;
  if (
    select count(*)
    from public.tracking_sync_steps
    where attempt_id = '43000000-0000-0000-0000-000000000004'
  ) <> 3 then
    raise exception 'tracking audit did not retain every supplied step';
  end if;
  if not exists (
    select 1
    from public.tracking_sync_health_24h
    where configured_carrier = 'dpd-fr'
      and attempts >= 1
      and anomalous >= 1
  ) or not exists (
    select 1
    from public.tracking_sync_recent_anomalies
    where attempt_id = '43000000-0000-0000-0000-000000000004'
      and package_id = '40000000-0000-0000-0000-000000000004'
  ) then
    raise exception 'tracking audit operator views omitted the completed anomaly';
  end if;
end;
$$;

insert into public.tracking_sync_attempts (
  id, package_id, trigger, configured_carrier, started_at
) values (
  '44000000-0000-0000-0000-000000000004',
  '40000000-0000-0000-0000-000000000004',
  'scheduled',
  'la-poste',
  now() - interval '31 minutes'
);

insert into public.tracking_sync_attempts (
  id,
  package_id,
  trigger,
  configured_carrier,
  outcome,
  current_step,
  started_at,
  completed_at,
  duration_ms
) values (
  '45000000-0000-0000-0000-000000000004',
  '40000000-0000-0000-0000-000000000004',
  'scheduled',
  'la-poste',
  'waiting',
  'complete',
  now() - interval '92 days',
  now() - interval '91 days',
  1000
);

do $$
declare
  maintenance record;
begin
  select * into maintenance from public.maintain_tracking_sync_audit();
  if maintenance.abandoned < 1 or maintenance.purged < 1 then
    raise exception 'tracking audit maintenance returned unexpected counts: %', maintenance;
  end if;
  if not exists (
    select 1
    from public.tracking_sync_attempts
    where id = '44000000-0000-0000-0000-000000000004'
      and outcome = 'abandoned'
      and error_type = 'WorkerAbandonedAttempt'
      and anomaly_codes @> array['worker_abandoned_attempt']
  ) then
    raise exception 'stale tracking audit was not marked abandoned';
  end if;
  if exists (
    select 1
    from public.tracking_sync_attempts
    where id = '45000000-0000-0000-0000-000000000004'
  ) then
    raise exception 'expired tracking audit was not purged';
  end if;
end;
$$;

reset role;

select 'per-user ownership and RLS assertions passed' as result;
