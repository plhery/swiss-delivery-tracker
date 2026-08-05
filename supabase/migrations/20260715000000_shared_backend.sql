-- Cloudflare Access is the only user boundary. The application server owns one
-- shared parcel collection and is the only client allowed to reach these tables.

alter table public.packages
  alter column user_id drop not null,
  alter column user_id drop default;

alter table public.packages
  drop constraint if exists packages_user_id_tracking_number_key,
  drop constraint if exists packages_user_id_fkey,
  add constraint packages_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete set null;

create unique index if not exists packages_tracking_number_shared_key
  on public.packages (tracking_number);

drop policy if exists "own packages" on public.packages;
drop policy if exists "events of own packages" on public.tracking_events;

revoke all on public.packages, public.tracking_events from anon, authenticated;
grant select, insert, update, delete on public.packages, public.tracking_events to service_role;
grant usage, select on all sequences in schema public to service_role;

drop function if exists public.claim_legacy_packages(text);
drop table if exists private.delivery_recovery_codes;

comment on column public.packages.user_id is
  'Legacy provenance only; new shared packages are owned by the application server.';
