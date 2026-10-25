-- =====================================================================
-- 51_companies_server_undo.sql — remove what 51_companies_server.sql added
-- =====================================================================
-- The Companies page goes back to reading the whole list in the browser.
-- Your companies, contacts and deals are not touched.
-- =====================================================================
do $$
declare t record;
begin
  for t in select tgname, c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where tgname like 'cof51\_%' loop
    execute format('drop trigger %I on public.%I', t.tgname, t.relname);
  end loop;
end $$;

drop function if exists public.companies_list(jsonb, text, int, int, text, jsonb);
drop function if exists public.companies_rows(uuid[]);
drop function if exists public.company_row_json(uuid);
drop function if exists public.companies_facets();
drop function if exists public.companies_light();
drop function if exists public.companies_view_sql(jsonb, text, jsonb);
drop function if exists public.companies_fx(text, text, jsonb);
drop function if exists public.cof_trg_companies();
drop function if exists public.cof_trg_links();
drop function if exists public.cof_trg_deals();
drop function if exists public.cof_trg_tenant_wide();
drop function if exists public.cof_refresh_tenants(uuid[]);
drop function if exists public.cof_refresh(uuid[]);
drop table if exists public.company_facts;
drop index if exists public.ix51_companies_parent;
drop index if exists public.ix51_companies_tenant_created;

select 'Companies list is back to the old way' as done;
