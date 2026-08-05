-- Swiss Delivery Tracker — initial schema.
-- Parcels belong to a (possibly anonymous) Supabase auth user;
-- tracking events hang off parcels. RLS keeps every user's data private.

create table public.packages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tracking_number text not null check (char_length(tracking_number) between 4 and 40),
  label text not null default '',
  carrier text not null default 'unknown',
  created_at timestamptz not null default now(),
  unique (user_id, tracking_number)
);

create table public.tracking_events (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.packages (id) on delete cascade,
  stage text not null check (
    stage in (
      'registered',
      'accepted',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'customs',
      'failed_attempt',
      'ready_for_pickup',
      'returned'
    )
  ),
  description text not null default '',
  location text,
  occurred_at timestamptz not null default now()
);

create index tracking_events_package_idx
  on public.tracking_events (package_id, occurred_at desc);

alter table public.packages enable row level security;
alter table public.tracking_events enable row level security;

create policy "own packages" on public.packages
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "events of own packages" on public.tracking_events
  for all
  using (
    exists (
      select 1 from public.packages p
      where p.id = package_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.packages p
      where p.id = package_id and p.user_id = auth.uid()
    )
  );

-- Live updates in the app.
alter publication supabase_realtime add table public.packages;
alter publication supabase_realtime add table public.tracking_events;
