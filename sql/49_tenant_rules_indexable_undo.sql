-- =====================================================================
-- 49_tenant_rules_indexable_undo.sql — put the tenant rules back as before 49
-- =====================================================================
do $$
declare r record;
begin
  if to_regclass('public.rls_bk49') is null then
    raise exception 'No backup (rls_bk49). Nothing to undo.';
  end if;
  for r in select * from public.rls_bk49 loop
    if r.qual is not null then
      execute format('alter policy %I on public.%I using (%s)', r.policy, r.tbl, r.qual);
    end if;
    if r.with_check is not null then
      execute format('alter policy %I on public.%I with check (%s)', r.policy, r.tbl, r.with_check);
    end if;
  end loop;
end $$;

select case when qual ~ 'is_superadmin' then 'old: tenant OR superadmin' else 'new: tenant only' end as rule_form,
       count(*) as tables
from pg_policies
where schemaname = 'public' and policyname = 'tenant_isolation'
group by 1
order by 1;
