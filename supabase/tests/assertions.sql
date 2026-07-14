\set ON_ERROR_STOP on

insert into auth.users (id, email, is_anonymous) values
  ('10000000-0000-0000-0000-000000000001', 'owner@example.test', false),
  ('20000000-0000-0000-0000-000000000002', 'other@example.test', false),
  ('30000000-0000-0000-0000-000000000003', null, true)
on conflict (id) do nothing;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.packages, public.tracking_events to authenticated;
grant usage, select on all sequences in schema public to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);

insert into public.packages (
  id, tracking_number, label, carrier
) values (
  '40000000-0000-0000-0000-000000000004', 'OWNER-TRACKING-1', 'Owner parcel', 'swiss-post'
);

do $$
declare
  owner_id uuid;
  initial_events integer;
begin
  select user_id into owner_id
  from public.packages
  where id = '40000000-0000-0000-0000-000000000004';
  if owner_id <> '10000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'auth.uid() did not own the inserted package';
  end if;

  select count(*) into initial_events
  from public.tracking_events
  where package_id = '40000000-0000-0000-0000-000000000004'
    and provider_event_id = 'app:registered';
  if initial_events <> 1 then
    raise exception 'initial tracking event trigger produced % rows', initial_events;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);

do $$
declare
  visible integer;
  changed integer;
begin
  select count(*) into visible from public.packages;
  if visible <> 0 then
    raise exception 'RLS exposed another user''s packages';
  end if;

  update public.packages
  set label = 'stolen'
  where id = '40000000-0000-0000-0000-000000000004';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'RLS allowed another user to update a package';
  end if;

  begin
    insert into public.packages (user_id, tracking_number)
    values ('10000000-0000-0000-0000-000000000001', 'FORGED-OWNER');
    raise exception 'expected RLS to reject forged ownership';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

do $$
begin
  begin
    update public.packages
    set current_stage = 'teleported'
    where id = '40000000-0000-0000-0000-000000000004';
    raise exception 'expected current_stage constraint failure';
  exception when check_violation then
    null;
  end;

  begin
    update public.packages
    set sync_status = 'mystery'
    where id = '40000000-0000-0000-0000-000000000004';
    raise exception 'expected sync_status constraint failure';
  exception when check_violation then
    null;
  end;
end;
$$;

insert into public.tracking_events (
  package_id, stage, description, provider_event_id
) values (
  '40000000-0000-0000-0000-000000000004', 'in_transit', 'Sorted', 'provider:event-1'
) on conflict do nothing;

insert into public.tracking_events (
  package_id, stage, description, provider_event_id
) values (
  '40000000-0000-0000-0000-000000000004', 'in_transit', 'Sorted again', 'provider:event-1'
) on conflict do nothing;

do $$
declare
  duplicates integer;
  published integer;
begin
  select count(*) into duplicates
  from public.tracking_events
  where package_id = '40000000-0000-0000-0000-000000000004'
    and provider_event_id = 'provider:event-1';
  if duplicates <> 1 then
    raise exception 'provider event deduplication failed';
  end if;

  select count(*) into published
  from pg_publication_tables
  where pubname = 'supabase_realtime'
    and schemaname = 'public'
    and tablename in ('packages', 'tracking_events');
  if published <> 2 then
    raise exception 'realtime publication is incomplete';
  end if;
end;
$$;

insert into public.packages (
  id, user_id, tracking_number, label, carrier
) values (
  '50000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000003',
  'LEGACY-TRACKING-1',
  'Legacy parcel',
  'swiss-post'
);

insert into private.delivery_recovery_codes (code_hash)
values (extensions.crypt('one-time-code', extensions.gen_salt('bf')));

set role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);

do $$
declare
  moved integer;
  new_owner uuid;
begin
  moved := public.claim_legacy_packages('one-time-code');
  if moved <> 1 then
    raise exception 'expected one recovered package, got %', moved;
  end if;

  select user_id into new_owner
  from public.packages
  where id = '50000000-0000-0000-0000-000000000005';
  if new_owner <> '10000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'recovery did not transfer package ownership';
  end if;

  begin
    perform public.claim_legacy_packages('one-time-code');
    raise exception 'expected one-time code reuse to fail';
  exception when raise_exception then
    if sqlerrm not like 'Invalid or already-used recovery code%' then
      raise;
    end if;
  end;
end;
$$;

reset role;

insert into private.delivery_recovery_codes (code_hash)
values (extensions.crypt('anonymous-code', extensions.gen_salt('bf')));

set role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000003', false);

do $$
begin
  begin
    perform public.claim_legacy_packages('anonymous-code');
    raise exception 'expected anonymous recovery to fail';
  exception when raise_exception then
    if sqlerrm not like 'A permanent account is required%' then
      raise;
    end if;
  end;
end;
$$;

reset role;

do $$
declare
  used_codes integer;
begin
  select count(*) into used_codes
  from private.delivery_recovery_codes
  where used_at is not null
    and used_by = '10000000-0000-0000-0000-000000000001';
  if used_codes <> 1 then
    raise exception 'recovery code audit fields were not recorded';
  end if;
end;
$$;

select 'migration assertions passed' as result;
