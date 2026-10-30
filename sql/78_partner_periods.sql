-- =====================================================================
-- 78_partner_periods.sql — the partner's periods and how each line is paid
-- =====================================================================
-- On every deal line (products and services):
--   · partner_periods: which periods (contract years) the partner's cut covers —
--     {"mode":"once"} = only the first one, {"mode":"recurring","skip":[2]} =
--     every year except year 3. Empty = as before (a % on every year, a fixed
--     amount once).
--   · billing_frequency: how the client pays it — upfront, annually,
--     semiannually, quarterly or monthly. The contract takes it from here
--     (licences and services each have their own).
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;

alter table public.tracking_products add column if not exists partner_periods jsonb;
alter table public.tracking_products add column if not exists billing_frequency text;
alter table public.tracking_potential_services add column if not exists partner_periods jsonb;
alter table public.tracking_potential_services add column if not exists billing_frequency text;

notify pgrst, 'reload schema';
commit;

select (select count(*) from information_schema.columns where table_schema = 'public'
          and table_name in ('tracking_products', 'tracking_potential_services')
          and column_name in ('partner_periods', 'billing_frequency')) as columns_ready;
