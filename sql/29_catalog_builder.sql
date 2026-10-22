-- =====================================================================
-- 29_catalog_builder.sql — multi-year contracts on products
-- =====================================================================
-- Settings › Products & services › a product › Pricing › "Contract length".
-- A product can be marked as sold for several years, with its usual length
-- and an annual increase (a percentage on the year before, or a fixed amount
-- per year). The deal calculator starts from these values.
--
-- Safe to run more than once. Nothing else changes: products keep their
-- tenant, policies and data; every existing product stays single-year.
-- =====================================================================

alter table public.products add column if not exists multi_year      boolean not null default false;
alter table public.products add column if not exists default_years   integer not null default 1;
alter table public.products add column if not exists increment_mode  text    not null default 'none';
alter table public.products add column if not exists increment_value numeric not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_default_years_check') then
    alter table public.products add constraint products_default_years_check check (default_years between 1 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_increment_mode_check') then
    alter table public.products add constraint products_increment_mode_check check (increment_mode in ('none', 'percent', 'amount'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_increment_value_check') then
    alter table public.products add constraint products_increment_value_check check (increment_value >= 0);
  end if;
end $$;

-- let the API see the new columns straight away
notify pgrst, 'reload schema';

-- result: your products with their contract settings
select name, billing, billing_period, multi_year, default_years, increment_mode, increment_value
from public.products
order by created_at;
