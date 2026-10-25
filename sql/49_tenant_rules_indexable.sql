-- =====================================================================
-- 49_tenant_rules_indexable.sql — tenant rule that can use the index
-- =====================================================================
-- Every table has the rule
--     tenant_id = current_tenant()  OR  is_superadmin()
-- Because of that "OR", Postgres can't jump straight to your company's rows
-- with the tenant index: it reads the rows of EVERY tenant and throws the
-- others away. With one tenant you don't notice; with thousands of tenants
-- (millions of rows) every list would read the whole table.
--
-- This rewrites those rules to
--     tenant_id = current_tenant()
-- so each query only touches its own tenant's rows (index).
--
-- What changes: a superadmin no longer sees other tenants' data inside the
-- normal app (the superadmin console keeps working: it goes through its own
-- server function, and "act as" signs in as that person). Everyone else:
-- nothing changes.
--
-- Safe to run more than once. Old rules saved in rls_bk49.
-- Undo: 49_tenant_rules_indexable_undo.sql
-- =====================================================================
do $$
declare r record; n int := 0; q text; c text; pat text;
begin
  create table if not exists public.rls_bk49 (
    tbl text, policy text, qual text, with_check text, at timestamptz default now(),
    primary key (tbl, policy));
  alter table public.rls_bk49 enable row level security;

  -- the exact shape written by 36_performance.sql (whitespace-tolerant)
  pat := '^\(\(tenant_id = \( SELECT current_tenant\(\) AS current_tenant\)\) OR \( SELECT is_superadmin\(\) AS is_superadmin\)\)$';

  for r in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (qual ~ pat or coalesce(with_check, '') ~ pat)
  loop
    insert into public.rls_bk49 (tbl, policy, qual, with_check)
    values (r.tablename, r.policyname, r.qual, r.with_check)
    on conflict (tbl, policy) do nothing;
    if r.qual ~ pat then
      execute format('alter policy %I on public.%I using (tenant_id = (select public.current_tenant()))', r.policyname, r.tablename);
    end if;
    if coalesce(r.with_check, '') ~ pat then
      execute format('alter policy %I on public.%I with check (tenant_id = (select public.current_tenant()))', r.policyname, r.tablename);
    end if;
    n := n + 1;
  end loop;
  raise notice 'Rewrote % tenant rules.', n;
end $$;

-- result: how many rules use each form now (the old form should be 0)
select case when qual ~ 'is_superadmin' then 'old: tenant OR superadmin' else 'new: tenant only' end as rule_form,
       count(*) as tables
from pg_policies
where schemaname = 'public' and policyname = 'tenant_isolation'
group by 1
order by 1;
