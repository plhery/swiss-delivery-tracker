alter table public.packages
  add column if not exists dpd_postcode text;

alter table public.packages
  drop constraint if exists packages_dpd_postcode_check,
  add constraint packages_dpd_postcode_check
    check (
      dpd_postcode is null
      or (carrier = 'dpd' and dpd_postcode ~ '^[0-9]{4}$')
    );

grant insert (dpd_postcode) on public.packages to authenticated;

comment on column public.packages.dpd_postcode is
  'Recipient postcode supplied by the package owner for DPD verification.';

notify pgrst, 'reload schema';
