-- Keep new direct service-role writes aligned with the API's normalized format.
-- NOT VALID preserves any legacy rows created before server-side normalization;
-- PostgreSQL still enforces the constraint for every new or changed value.

alter table public.packages
  add constraint packages_tracking_number_format_check check (
    tracking_number ~ '^[A-Z0-9]+$'
    and tracking_number ~ '[0-9]'
  ) not valid;
