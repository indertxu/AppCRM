-- 112 · Changing a company field's choices no longer rebuilds the whole workspace's contact list.
-- company_fields' statement trigger (cf50_cof_*) refreshed every contact of the tenant on any insert or
-- update — 10–15 s with ~14k companies, so the CRM import API (111) timed out adding a new choice.
-- A new field has no values yet and new choices don't change any value: only a renamed / retyped
-- field, or a deleted one, needs the refresh.
create or replace function public.cf_trg_tenant_wide()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare ts uuid[] := '{}';
begin
  if tg_op = 'UPDATE' then
    ts := ts || array(select public.cf_row_tenant(to_jsonb(n)) from newrows n join oldrows o on o.id = n.id
                       where n.label is distinct from o.label or n.type is distinct from o.type);
  elsif tg_op = 'DELETE' then
    ts := ts || array(select public.cf_row_tenant(to_jsonb(o)) from oldrows o);
  end if;
  if coalesce(array_length(ts, 1), 0) > 0 then
    perform public.cf_refresh_tenants(array(select distinct x from unnest(ts) x where x is not null));
  end if;
  return null;
end $$;
