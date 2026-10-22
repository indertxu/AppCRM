-- =====================================================================
-- 27_deal_contracts.sql — contracts of won deals, yearly increases, revenue view
-- =====================================================================
-- 1. tracking_products.increments   yearly price increases of a multi-year product
--                                   line ({"mode":"pct"|"fixed"|"custom","value":3,"perYear":[…]})
-- 2. trackings.contract_terms       the contract of a won deal (sign date, contract
--                                   start, term, final licence / services prices,
--                                   year-by-year schedule) — written by the contract panel
-- 3. deal_settings                  the team's "potential revenue" figure
--                                   (product first year / all years / + services …)
-- New table copies the access rules of crm_options. Safe to run more than once.
-- =====================================================================
begin;

create or replace function pg_temp.copy_policies(src text, dst text) returns int language plpgsql as $$
declare p record; n int := 0;
begin
  execute format('alter table public.%I enable row level security', dst);
  for p in select * from pg_policies where schemaname = 'public' and tablename = src loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst and policyname = p.policyname) then n := n + 1; continue; end if;
    begin
      execute format('create policy %I on public.%I as %s for %s to %s %s %s',
        p.policyname, dst, p.permissive, p.cmd, array_to_string(p.roles, ', '),
        case when p.qual is not null then 'using (' || p.qual || ')' else '' end,
        case when p.with_check is not null then 'with check (' || p.with_check || ')' else '' end);
      n := n + 1;
    exception when others then
      raise notice 'policy % not copied to %: %', p.policyname, dst, sqlerrm;
    end;
  end loop;
  if n = 0 and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst) then
    execute format('create policy tenant_all on public.%I for all to authenticated using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', dst);
  end if;
  return n;
end $$;

-- ---------- 1. Yearly increases on product lines ----------
alter table public.tracking_products add column if not exists increments jsonb;

-- ---------- 2. Contract of a won deal ----------
alter table public.trackings add column if not exists contract_terms jsonb;

-- ---------- 3. Team setting: which potential revenue figure ----------
create table if not exists public.deal_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid unique,
  revenue_mode text not null default 'product_year1'
    check (revenue_mode in ('product_year1', 'product_term', 'all_year1', 'all_term')),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_set_tenant on public.deal_settings;
create trigger trg_set_tenant before insert on public.deal_settings for each row execute function set_tenant_id();
select pg_temp.copy_policies('crm_options', 'deal_settings');
grant select, insert, update, delete on public.deal_settings to authenticated;

commit;

notify pgrst, 'reload schema';

select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tracking_products' and column_name = 'increments') as increments_column,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'trackings' and column_name = 'contract_terms') as contract_terms_column,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'deal_settings') as deal_settings_policies;
