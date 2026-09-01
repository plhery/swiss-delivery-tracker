-- Let an owner correct a parcel's carrier without recreating its identity.
-- Old provider events and status fields are cleared atomically so histories
-- from two different carriers can never be presented as one journey.

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
    'shipup', 'intl-post', 'unknown'
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

  -- Release any old-carrier job's deduplication key so the API can enqueue a
  -- fresh check immediately. A worker already in flight may finish, but the
  -- newly queued check is authoritative and will run afterwards.
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

notify pgrst, 'reload schema';
