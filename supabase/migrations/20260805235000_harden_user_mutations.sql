-- Keep public PostgREST useful for account-scoped reads while ensuring every
-- mutation passes the same validation and quota boundary as the application API.

alter table public.packages
  add constraint packages_label_length_check
    check (char_length(label) <= 80) not valid,
  add constraint packages_carrier_check
    check (
      carrier in (
        'swiss-post', 'quickpac', 'planzer', 'aliexpress', 'sunyou',
        'hermes', 'spring-gds', 'postlogistics', 'dachser', 'dhl', 'ups',
        'fedex', 'dpd', 'shipup', 'intl-post', 'unknown'
      )
    ) not valid,
  add constraint packages_tracking_url_check
    check (
      tracking_url is null
      or (
        carrier = 'planzer'
        and char_length(tracking_url) <= 4096
        and tracking_url ~ '^https://trackandtrace[.]planzergroup[.]com(?::443)?/shared/sendungen/'
      )
    ) not valid;

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
    'swiss-post', 'quickpac', 'planzer', 'aliexpress', 'sunyou',
    'hermes', 'spring-gds', 'postlogistics', 'dachser', 'dhl', 'ups',
    'fedex', 'dpd', 'shipup', 'intl-post', 'unknown'
  ) then
    raise exception 'Unsupported carrier' using errcode = '22023';
  end if;
  if normalized_url is not null and (
    p_carrier <> 'planzer'
    or char_length(normalized_url) > 4096
    or normalized_url !~ '^https://trackandtrace[.]planzergroup[.]com(?::443)?/shared/sendungen/'
  ) then
    raise exception 'Invalid tracking URL' using errcode = '22023';
  end if;
  if (p_carrier = 'dpd' and coalesce(normalized_postcode, '') !~ '^[0-9]{4}$')
      or (p_carrier <> 'dpd' and normalized_postcode is not null) then
    raise exception 'Invalid DPD postcode' using errcode = '22023';
  end if;

  -- Serialize quota checks per account so concurrent direct PostgREST calls
  -- cannot race past the limits.
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

create or replace function public.rename_owned_package(p_package_id uuid, p_label text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor_id uuid := auth.uid();
  changed boolean;
  normalized_label text := btrim(coalesce(p_label, ''));
begin
  if actor_id is null or char_length(normalized_label) > 80 then
    raise exception 'Invalid parcel name' using errcode = '22023';
  end if;
  update public.packages
  set label = normalized_label
  where id = p_package_id and user_id = actor_id
  returning true into changed;
  return coalesce(changed, false);
end;
$$;

create or replace function public.set_owned_package_archived(
  p_package_id uuid,
  p_archived boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor_id uuid := auth.uid();
  changed boolean;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  update public.packages
  set archived_at = case when p_archived then now() else null end
  where id = p_package_id and user_id = actor_id
  returning true into changed;
  return coalesce(changed, false);
end;
$$;

revoke insert, update, delete on public.packages from authenticated;
revoke insert (tracking_number, label, carrier, tracking_url, dpd_postcode)
  on public.packages from authenticated;
revoke update (label, archived_at) on public.packages from authenticated;
revoke all on function public.create_owned_package(text, text, text, text, text) from public;
revoke all on function public.rename_owned_package(uuid, text) from public;
revoke all on function public.set_owned_package_archived(uuid, boolean) from public;
grant execute on function public.create_owned_package(text, text, text, text, text) to authenticated;
grant execute on function public.rename_owned_package(uuid, text) to authenticated;
grant execute on function public.set_owned_package_archived(uuid, boolean) to authenticated;

-- Disable any pre-hardening subscription that could make the background worker
-- request an arbitrary host. Disabled legacy rows remain for auditability, while
-- the constraint rejects every new or re-enabled endpoint outside browser push
-- providers used by FCM, Mozilla, Apple, and Windows Push Notification Services.
update public.push_subscriptions
set
  disabled_at = coalesce(disabled_at, now()),
  last_error = 'Push endpoint disabled by the provider allowlist'
where endpoint !~* '^https://(android[.]googleapis[.]com|fcm[.]googleapis[.]com|push[.]services[.]mozilla[.]com|updates[.]push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|([a-z0-9-]+[.])+notify[.]windows[.]com)(:443)?(/[^#]*)?$';

alter table public.push_subscriptions
  add constraint push_subscriptions_provider_endpoint_check
    check (
      disabled_at is not null
      or endpoint ~* '^https://(android[.]googleapis[.]com|fcm[.]googleapis[.]com|push[.]services[.]mozilla[.]com|updates[.]push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|([a-z0-9-]+[.])+notify[.]windows[.]com)(:443)?(/[^#]*)?$'
    ) not valid;

comment on function public.create_owned_package(text, text, text, text, text) is
  'Validated and quota-enforced package creation for the current authenticated account.';

notify pgrst, 'reload schema';
