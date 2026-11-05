-- =====================================================================
-- 102 · BASE · How a service bills, and its price (Base's simple catalog)
-- Settings › Products & Services in the Base app: a service is a name,
-- its steps (phase_blueprints, linked by services.blueprint_id — the same
-- template Enterprise uses for project phases) and how it bills:
--   upfront  — a fixed price, billed before the work starts
--   by_step  — a fixed price, billed as each step is done (the steps' %)
--   monthly  — a monthly fee while it runs
--   hourly / daily — a rate per hour / per day (rate_unit kept in step)
-- Only adds columns: Enterprise doesn't read them and keeps working as before
-- (its prices stay in service_roles). Existing services start as hourly /
-- daily from their rate_unit.
-- =====================================================================
alter table public.services add column if not exists billing text not null default 'hourly';
alter table public.services add column if not exists price numeric not null default 0;

update public.services set billing = 'daily' where rate_unit = 'day' and billing = 'hourly';

alter table public.services drop constraint if exists services_billing_chk;
alter table public.services add constraint services_billing_chk
  check (billing in ('upfront', 'by_step', 'monthly', 'hourly', 'daily'));
alter table public.services drop constraint if exists services_price_chk;
alter table public.services add constraint services_price_chk check (price >= 0);
