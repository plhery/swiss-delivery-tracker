-- Restoring an archived parcel increases the active-parcel count, so it must
-- use the same serialized quota check as parcel creation.
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
  current_archived_at timestamptz;
  active_count integer;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_archived is null then
    raise exception 'Archive state is required' using errcode = '22023';
  end if;

  -- Coordinate restores with create_owned_package so concurrent calls cannot
  -- race past the per-account active-parcel limit.
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text, 0));

  select archived_at
  into current_archived_at
  from public.packages
  where id = p_package_id and user_id = actor_id;

  if not found then
    return false;
  end if;

  if p_archived then
    update public.packages
    set archived_at = now()
    where id = p_package_id and user_id = actor_id;
    return true;
  end if;

  -- Restoring an already-active parcel is idempotent and does not consume
  -- another quota slot.
  if current_archived_at is null then
    return true;
  end if;

  select count(*)
  into active_count
  from public.packages
  where user_id = actor_id and archived_at is null;

  if active_count >= 50 then
    raise exception 'Parcel limit reached' using errcode = 'P0001';
  end if;

  update public.packages
  set archived_at = null
  where id = p_package_id and user_id = actor_id;
  return true;
end;
$$;

comment on function public.set_owned_package_archived(uuid, boolean) is
  'Quota-enforced archive and restore for a package owned by the current account.';

notify pgrst, 'reload schema';
