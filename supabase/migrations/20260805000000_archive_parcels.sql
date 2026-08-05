-- Soft-archive old deliveries without deleting their tracking history.

create index if not exists packages_archive_candidates_idx
  on public.packages (last_synced_at)
  where archived_at is null and current_stage = 'delivered';

create index if not exists packages_archived_at_idx
  on public.packages (archived_at desc)
  where archived_at is not null;
