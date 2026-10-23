-- =====================================================================
-- 36_performance_undo.sql — undo 36_performance.sql
-- =====================================================================
-- 1. Puts every row-level rule back exactly as it was (from perf_policies_bk36).
-- 2. Drops the indexes 36 created (listed in perf_indexes_bk36).
-- pg_trgm stays installed (harmless). Safe to run more than once.
-- =====================================================================

do $$
declare p record; i record; n int := 0; m int := 0;
begin
  if to_regclass('public.perf_policies_bk36') is not null then
    for p in select * from public.perf_policies_bk36 loop
      begin
        execute format('drop policy if exists %I on public.%I', p.policy_name, p.table_name);
        execute format('create policy %I on public.%I as %s for %s to %s %s %s',
          p.policy_name, p.table_name, p.permissive, p.cmd,
          (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(p.roles) r),
          case when p.old_qual is not null then 'using (' || p.old_qual || ')' else '' end,
          case when p.old_with_check is not null then 'with check (' || p.old_with_check || ')' else '' end);
        n := n + 1;
      exception when others then
        raise notice 'rule % on % not restored: %', p.policy_name, p.table_name, sqlerrm;
      end;
    end loop;
    delete from public.perf_policies_bk36;
  end if;

  if to_regclass('public.perf_indexes_bk36') is not null then
    for i in select * from public.perf_indexes_bk36 loop
      execute format('drop index if exists public.%I', i.index_name);
      m := m + 1;
    end loop;
    delete from public.perf_indexes_bk36;
  end if;
  raise notice 'Rules restored: %, indexes dropped: %', n, m;
end $$;

select 'undo done' as status;
