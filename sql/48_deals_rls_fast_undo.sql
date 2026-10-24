-- =====================================================================
-- 48_deals_rls_fast_undo.sql — put the access rules back as before 48
-- =====================================================================
do $$
declare r record;
begin
  if to_regclass('public.rls_bk48') is null then
    raise exception 'No backup (rls_bk48). Nothing to undo.';
  end if;
  for r in select * from public.rls_bk48 loop
    if r.qual is not null then
      execute format('alter policy %I on public.%I using (%s)', r.policy, r.tbl, r.qual);
    end if;
    if r.with_check is not null then
      execute format('alter policy %I on public.%I with check (%s)', r.policy, r.tbl, r.with_check);
    end if;
  end loop;
end $$;

select tablename as "table", policyname as rule, qual as rule_now
from pg_policies
where schemaname = 'public' and qual ~ 'can_see_tracking\('
order by 1, 2;
