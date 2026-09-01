-- Add India Post as a first-class automatic carrier. Existing UPU S10
-- shipments issued by India were previously assigned to the generic,
-- non-selectable international-post fallback; move them to the new adapter.

alter table public.packages
  drop constraint if exists packages_carrier_check,
  add constraint packages_carrier_check
    check (
      carrier in (
        'swiss-post', 'swiss-post-cargo', 'quickpac', 'planzer',
        'aliexpress', 'sunyou', 'hermes', 'spring-gds', 'postlogistics',
        'dachser', 'dhl', 'ups', 'amazon-logistics', 'fedex', 'gls-ch',
        'dpd', 'dpd-fr', 'mondial-relay', 'relais-colis', 'la-poste',
        'chronopost', 'gls-fr', 'colis-prive', 'geodis', 'colisweb',
        'c-chez-vous', 'heppner', 'ciblex', 'paack', 'asendia',
        'shipup', 'india-post', 'intl-post', 'unknown'
      )
    ) not valid;

alter table public.packages validate constraint packages_carrier_check;

create or replace function public.create_owned_package(
  p_tracking_number text,
  p_label text default '',
  p_carrier text default 'unknown',
  p_tracking_url text default null,
  p_dpd_postcode text default null
)
returns public.packages
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor_id uuid := auth.uid();
  normalized_tracking text;
  normalized_label text := btrim(coalesce(p_label, ''));
  normalized_url text := nullif(btrim(coalesce(p_tracking_url, '')), '');
  normalized_postcode text := nullif(btrim(coalesce(p_dpd_postcode, '')), '');
  active_count integer;
  total_count integer;
  created public.packages;
begin
  if actor_id is null or exists (
    select 1 from auth.users where id = actor_id and is_anonymous
  ) then
    raise exception 'A permanent account is required' using errcode = '42501';
  end if;

  normalized_tracking := upper(regexp_replace(coalesce(p_tracking_number, ''), '[[:space:].-]', '', 'g'));
  if char_length(normalized_tracking) not between 4 and 40
      or normalized_tracking !~ '^[A-Z0-9]+$'
      or normalized_tracking !~ '[0-9]' then
    raise exception 'Invalid tracking number' using errcode = '22023';
  end if;
  if char_length(normalized_label) > 80 then
    raise exception 'Parcel names can be at most 80 characters' using errcode = '22023';
  end if;
  if p_carrier is null or p_carrier not in (
    'swiss-post', 'swiss-post-cargo', 'quickpac', 'planzer',
    'aliexpress', 'sunyou', 'hermes', 'spring-gds', 'postlogistics',
    'dachser', 'dhl', 'ups', 'amazon-logistics', 'fedex', 'gls-ch',
    'dpd', 'dpd-fr', 'mondial-relay', 'relais-colis', 'la-poste',
    'chronopost', 'gls-fr', 'colis-prive', 'geodis', 'colisweb',
    'c-chez-vous', 'heppner', 'ciblex', 'paack', 'asendia',
    'shipup', 'india-post', 'intl-post', 'unknown'
  ) then
    raise exception 'Unsupported carrier' using errcode = '22023';
  end if;
  if p_carrier = 'dachser' and normalized_url is null then
    raise exception 'Dachser requires its complete tracking URL' using errcode = '22023';
  end if;
  if normalized_url is not null and not (
    (
      p_carrier = 'planzer'
      and char_length(normalized_url) <= 4096
      and normalized_url ~ '^https://trackandtrace[.]planzergroup[.]com(?::443)?/shared/sendungen/'
    )
    or (
      p_carrier = 'dachser'
      and char_length(normalized_url) <= 4096
      and normalized_url ~ '^https://customeriberia[.]dachser[.]com(?::443)?/customerarea/utilidades/seguimiento-publico/detalle[?]'
      and normalized_url ~ ('[?&]numeroUnico=' || normalized_tracking || '([&#]|$)')
      and (
        normalized_url ~ '[?&]hash=[A-Za-z0-9_-]{4,255}[A-Za-z0-9_-]?([&#]|$)'
        or (
          normalized_url ~ '[?&]clave=[A-Za-z0-9_-]{4,255}[A-Za-z0-9_-]?([&#]|$)'
          and normalized_url ~ '[?&]fecha=[0-9]{8}([&#]|$)'
        )
      )
    )
  ) then
    raise exception 'Invalid tracking URL' using errcode = '22023';
  end if;

  if p_carrier = 'paack' and normalized_postcode is not null then
    normalized_postcode := upper(normalized_postcode);
    if char_length(normalized_postcode) not between 3 and 10
        or normalized_postcode !~ '[0-9]'
        or normalized_postcode !~ '^[A-Z0-9]+([ -][A-Z0-9]+)*$' then
      raise exception 'Invalid Paack delivery postcode' using errcode = '22023';
    end if;
    normalized_postcode := upper(regexp_replace(normalized_postcode, '[[:space:]]', '', 'g'));
  end if;
  if (p_carrier in ('dpd', 'gls-ch') and coalesce(normalized_postcode, '') !~ '^[0-9]{4}$')
      or (p_carrier = 'mondial-relay' and coalesce(normalized_postcode, '') !~ '^[0-9]{5}$')
      or (p_carrier = 'heppner' and coalesce(normalized_postcode, '') !~ '^[0-9]{4,5}$')
      or (
        p_carrier = 'paack'
        and (
          normalized_postcode is null
          or char_length(normalized_postcode) not between 3 and 10
          or normalized_postcode !~ '[0-9]'
          or normalized_postcode !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'
        )
      )
      or (
        p_carrier not in ('dpd', 'gls-ch', 'mondial-relay', 'heppner', 'paack')
        and normalized_postcode is not null
      ) then
    raise exception 'Invalid delivery postcode' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(actor_id::text, 0));
  select
    count(*) filter (where archived_at is null),
    count(*)
  into active_count, total_count
  from public.packages
  where user_id = actor_id;
  if active_count >= 50 or total_count >= 500 then
    raise exception 'Parcel limit reached' using errcode = 'P0001';
  end if;

  insert into public.packages (
    user_id, tracking_number, label, carrier, tracking_url, dpd_postcode
  ) values (
    actor_id,
    normalized_tracking,
    normalized_label,
    p_carrier,
    normalized_url,
    normalized_postcode
  )
  returning * into created;
  return created;
end;
$$;

comment on function public.create_owned_package(text, text, text, text, text) is
  'Validated, quota-enforced package creation for the current permanent account.';

create or replace function public.change_owned_package_carrier(
  p_package_id uuid,
  p_carrier text,
  p_tracking_url text default null,
  p_dpd_postcode text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor_id uuid := auth.uid();
  tracking_number text;
  normalized_carrier text := p_carrier;
  normalized_url text := nullif(btrim(coalesce(p_tracking_url, '')), '');
  normalized_postcode text := nullif(btrim(coalesce(p_dpd_postcode, '')), '');
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select package.tracking_number
  into tracking_number
  from public.packages as package
  where package.id = p_package_id
    and package.user_id = actor_id
  for update;

  if not found then return false; end if;

  if tracking_number ~ '^44[0-9]{16}$' then normalized_carrier := 'quickpac'; end if;
  if normalized_carrier is null or normalized_carrier not in (
    'swiss-post', 'swiss-post-cargo', 'quickpac', 'planzer',
    'aliexpress', 'sunyou', 'hermes', 'spring-gds', 'postlogistics',
    'dachser', 'dhl', 'ups', 'amazon-logistics', 'fedex', 'gls-ch',
    'dpd', 'dpd-fr', 'mondial-relay', 'relais-colis', 'la-poste',
    'chronopost', 'gls-fr', 'colis-prive', 'geodis', 'colisweb',
    'c-chez-vous', 'heppner', 'ciblex', 'paack', 'asendia',
    'shipup', 'india-post', 'intl-post', 'unknown'
  ) then
    raise exception 'Unsupported carrier' using errcode = '22023';
  end if;

  if normalized_carrier = 'dachser' and normalized_url is null then
    raise exception 'Dachser requires its complete tracking URL' using errcode = '22023';
  end if;
  if normalized_url is not null and not (
    (
      normalized_carrier = 'planzer'
      and char_length(normalized_url) <= 4096
      and normalized_url ~ '^https://trackandtrace[.]planzergroup[.]com(?::443)?/shared/sendungen/'
    )
    or (
      normalized_carrier = 'dachser'
      and char_length(normalized_url) <= 4096
      and normalized_url ~ '^https://customeriberia[.]dachser[.]com(?::443)?/customerarea/utilidades/seguimiento-publico/detalle[?]'
      and normalized_url ~ ('[?&]numeroUnico=' || tracking_number || '([&#]|$)')
      and (
        normalized_url ~ '[?&]hash=[A-Za-z0-9_-]{4,255}[A-Za-z0-9_-]?([&#]|$)'
        or (
          normalized_url ~ '[?&]clave=[A-Za-z0-9_-]{4,255}[A-Za-z0-9_-]?([&#]|$)'
          and normalized_url ~ '[?&]fecha=[0-9]{8}([&#]|$)'
        )
      )
    )
  ) then
    raise exception 'Invalid tracking URL' using errcode = '22023';
  end if;

  if normalized_carrier = 'paack' and normalized_postcode is not null then
    normalized_postcode := upper(normalized_postcode);
    if char_length(normalized_postcode) not between 3 and 10
        or normalized_postcode !~ '[0-9]'
        or normalized_postcode !~ '^[A-Z0-9]+([ -][A-Z0-9]+)*$' then
      raise exception 'Invalid Paack delivery postcode' using errcode = '22023';
    end if;
    normalized_postcode := upper(regexp_replace(normalized_postcode, '[[:space:]]', '', 'g'));
  end if;
  if (normalized_carrier in ('dpd', 'gls-ch') and coalesce(normalized_postcode, '') !~ '^[0-9]{4}$')
      or (normalized_carrier = 'mondial-relay' and coalesce(normalized_postcode, '') !~ '^[0-9]{5}$')
      or (normalized_carrier = 'heppner' and coalesce(normalized_postcode, '') !~ '^[0-9]{4,5}$')
      or (
        normalized_carrier = 'paack'
        and (
          normalized_postcode is null
          or char_length(normalized_postcode) not between 3 and 10
          or normalized_postcode !~ '[0-9]'
          or normalized_postcode !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'
        )
      )
      or (
        normalized_carrier not in ('dpd', 'gls-ch', 'mondial-relay', 'heppner', 'paack')
        and normalized_postcode is not null
      ) then
    raise exception 'Invalid delivery postcode' using errcode = '22023';
  end if;

  update public.sync_jobs
  set
    state = 'failed',
    completed_at = now(),
    lease_until = null,
    locked_by = null,
    dedupe_key = null,
    last_error = 'Superseded because the package carrier changed.'
  where package_id = p_package_id
    and state in ('queued', 'running');

  delete from public.tracking_events where package_id = p_package_id;

  update public.packages
  set
    carrier = normalized_carrier,
    tracking_url = normalized_url,
    dpd_postcode = normalized_postcode,
    current_stage = 'pending',
    expected_delivery = null,
    expected_delivery_changed_at = null,
    last_status_text = null,
    last_synced_at = null,
    sync_status = 'pending',
    sync_error = null,
    carrier_data = '{}'::jsonb
  where id = p_package_id
    and user_id = actor_id;

  insert into public.tracking_events (
    package_id, stage, description, occurred_at, provider_event_id
  ) values (
    p_package_id, 'pending', 'Carrier changed; waiting for tracking', now(), 'app:pending'
  );

  return true;
end;
$$;

revoke all on function public.change_owned_package_carrier(uuid, text, text, text)
  from public, anon, service_role;
grant execute on function public.change_owned_package_carrier(uuid, text, text, text)
  to authenticated;

comment on function public.change_owned_package_carrier(uuid, text, text, text) is
  'Changes an owned package carrier and atomically resets stale tracking state and history.';

update public.sync_jobs
set
  state = 'failed',
  completed_at = now(),
  lease_until = null,
  locked_by = null,
  dedupe_key = null,
  last_error = 'Superseded because India Post tracking became available.'
where package_id in (
  select id
  from public.packages
  where carrier = 'intl-post'
    and tracking_number ~ '^[A-Z]{2}[0-9]{9}IN$'
)
and state in ('queued', 'running');

delete from public.tracking_events
where package_id in (
  select id
  from public.packages
  where carrier = 'intl-post'
    and tracking_number ~ '^[A-Z]{2}[0-9]{9}IN$'
);

with migrated as (
  update public.packages
  set
    carrier = 'india-post',
    current_stage = 'pending',
    expected_delivery = null,
    expected_delivery_changed_at = null,
    last_status_text = null,
    last_synced_at = null,
    sync_status = 'pending',
    sync_error = null,
    carrier_data = '{}'::jsonb
  where carrier = 'intl-post'
    and tracking_number ~ '^[A-Z]{2}[0-9]{9}IN$'
  returning id
)
insert into public.tracking_events (
  package_id, stage, description, occurred_at, provider_event_id
)
select
  id,
  'pending',
  'India Post tracking enabled; waiting for tracking',
  now(),
  'app:pending'
from migrated;

notify pgrst, 'reload schema';
