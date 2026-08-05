-- Restore Supabase Auth as the public user boundary. Existing account-owned
-- rows keep their owner. Rows created by the former shared backend remain
-- unowned and are deliberately invisible until the deployment owner assigns
-- them during the cutover.

alter table public.packages
  alter column user_id set default auth.uid();

alter table public.packages
  drop constraint if exists packages_user_id_fkey,
  add constraint packages_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade;

drop index if exists public.packages_tracking_number_shared_key;

alter table public.packages
  add constraint packages_user_id_tracking_number_key
    unique (user_id, tracking_number);

drop policy if exists "own packages" on public.packages;
drop policy if exists "events of own packages" on public.tracking_events;

create policy "select own packages" on public.packages
  for select to authenticated
  using (user_id = auth.uid());

create policy "insert own packages" on public.packages
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "update own packages" on public.packages
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "delete own packages" on public.packages
  for delete to authenticated
  using (user_id = auth.uid());

create policy "select events of own packages" on public.tracking_events
  for select to authenticated
  using (
    exists (
      select 1
      from public.packages as package
      where package.id = package_id
        and package.user_id = auth.uid()
    )
  );

revoke all on public.packages, public.tracking_events from anon, authenticated;
grant select on public.packages, public.tracking_events to authenticated;
grant insert (tracking_number, label, carrier, tracking_url)
  on public.packages to authenticated;
grant update (label, archived_at)
  on public.packages to authenticated;
grant delete on public.packages to authenticated;

comment on column public.packages.user_id is
  'Supabase Auth owner. NULL is reserved for pre-auth cutover rows and is never visible through RLS.';

notify pgrst, 'reload schema';
