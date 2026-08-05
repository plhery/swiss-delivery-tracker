create or replace function public.delete_owned_archived_package(p_package_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.packages
  where id = p_package_id
    and user_id = auth.uid()
    and archived_at is not null;

  return found;
end;
$$;

revoke all on function public.delete_owned_archived_package(uuid) from public;
grant execute on function public.delete_owned_archived_package(uuid) to authenticated;

comment on function public.delete_owned_archived_package(uuid) is
  'Permanently deletes one archived package owned by the signed-in user.';
