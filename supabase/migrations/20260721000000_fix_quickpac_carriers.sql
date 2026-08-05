-- Quickpac parcel numbers use the same 18-digit shape as Swiss Post, but the
-- carrier-specific 44 prefix lets us repair rows created by the old fallback.
update public.packages
set carrier = 'quickpac'
where carrier = 'swiss-post'
  and tracking_number ~ '^44[0-9]{16}$';
