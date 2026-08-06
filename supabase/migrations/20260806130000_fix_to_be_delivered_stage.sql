-- Swiss Post's TO_BE_DELIVERED status is prospective, not a delivery confirmation.
-- Repair rows written before the application classifier learned that distinction.

update public.tracking_events
set stage = 'in_transit'
where stage = 'delivered'
  and description = 'TO_BE_DELIVERED';

update public.packages
set current_stage = 'in_transit',
    sync_status = 'pending',
    last_synced_at = null
where current_stage = 'delivered'
  and last_status_text = 'TO_BE_DELIVERED';
