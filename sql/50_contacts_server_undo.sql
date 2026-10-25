-- =====================================================================
-- 50_contacts_server_undo.sql — remove what 50_contacts_server.sql added
-- =====================================================================
-- The Contacts page goes back to reading the whole list in the browser.
-- Your contacts, companies and deals are not touched.
-- =====================================================================
do $$
declare t record;
begin
  for t in select tgname, c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where tgname like 'cf50\_%' loop
    execute format('drop trigger %I on public.%I', t.tgname, t.relname);
  end loop;
end $$;

drop function if exists public.contacts_list(jsonb, text, int, int, text, jsonb);
drop function if exists public.contacts_rows(uuid[]);
drop function if exists public.contact_row_json(uuid);
drop function if exists public.contacts_facets();
drop function if exists public.contacts_view_sql(jsonb, text, jsonb);
drop function if exists public.contacts_fx(text, text, jsonb);
drop function if exists public.cf_trg_contacts();
drop function if exists public.cf_trg_links();
drop function if exists public.cf_trg_companies();
drop function if exists public.cf_trg_deals();
drop function if exists public.cf_trg_clients();
drop function if exists public.cf_trg_tenant_wide();
drop function if exists public.cf_refresh_tenants(uuid[]);
drop function if exists public.cf_refresh_companies(uuid[]);
drop function if exists public.cf_refresh(uuid[]);
drop table if exists public.contact_facts;
drop index if exists public.ix50_contacts_tenant_created;
-- fx_norm / fx_list / fx_num / fx_bool / list_cond_sql are shared helpers (51 uses them too); they are kept

select 'Contacts list is back to the old way' as done;
