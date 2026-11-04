-- 99: adding / renaming / removing a list option in Settings › Companies (sources, sectors,
-- products, ticket types…) was refreshing the facts of EVERY contact and company of the
-- tenant (~20 s), so the request timed out and "Add" seemed to do nothing.
-- The facts only read options of kind 'relationship' (company types), and only for the
-- companies that carry that label. So: other kinds refresh nothing, and company types
-- refresh just the companies tagged with the label (and their contacts); re-sorting refreshes nothing.

create or replace function public.crm_opt_facts_trg()
returns trigger language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  ts uuid[] := '{}';
  ls text[] := '{}';
  t uuid;
  cos uuid[];
  cts uuid[];
begin
  if tg_op = 'INSERT' then
    select coalesce(array_agg((to_jsonb(n) ->> 'tenant_id')::uuid), '{}'), coalesce(array_agg(lower(n.label)), '{}')
      into ts, ls from newrows n where n.kind = 'relationship';
  elsif tg_op = 'DELETE' then
    select coalesce(array_agg((to_jsonb(o) ->> 'tenant_id')::uuid), '{}'), coalesce(array_agg(lower(o.label)), '{}')
      into ts, ls from oldrows o where o.kind = 'relationship';
  else
    -- only rows whose label or kind changed (re-sorting the list costs nothing)
    select coalesce(array_agg(z.t), '{}'), coalesce(array_agg(z.l), '{}') into ts, ls from (
      select (to_jsonb(o) ->> 'tenant_id')::uuid t, lower(o.label) l
        from oldrows o join newrows n on n.id = o.id
       where o.kind = 'relationship' and (o.label is distinct from n.label or o.kind is distinct from n.kind)
      union all
      select (to_jsonb(n) ->> 'tenant_id')::uuid, lower(n.label)
        from oldrows o join newrows n on n.id = o.id
       where n.kind = 'relationship' and (o.label is distinct from n.label or o.kind is distinct from n.kind)) z;
  end if;
  if cardinality(ls) = 0 then return null; end if;

  foreach t in array array(select distinct x from unnest(ts) x where x is not null) loop
    select array_agg(c.id) into cos from public.companies c
     where c.tenant_id = t
       and exists (select 1 from unnest(coalesce(c.relationship, '{}')) x where lower(x) = any(ls));
    if cos is null then continue; end if;
    perform public.cof_refresh(cos);
    select array_agg(distinct cc.contact_id) into cts from public.company_contacts cc where cc.company_id = any(cos);
    if cts is not null then perform public.cf_refresh(cts); end if;
  end loop;
  return null;
end $$;

drop trigger if exists cf50_opt_ins on public.crm_options;
drop trigger if exists cf50_opt_upd on public.crm_options;
drop trigger if exists cf50_opt_del on public.crm_options;
drop trigger if exists cof51_opt_ins on public.crm_options;
drop trigger if exists cof51_opt_upd on public.crm_options;
drop trigger if exists cof51_opt_del on public.crm_options;

create trigger cf99_opt_ins after insert on public.crm_options
  referencing new table as newrows for each statement execute function public.crm_opt_facts_trg();
create trigger cf99_opt_upd after update on public.crm_options
  referencing old table as oldrows new table as newrows for each statement execute function public.crm_opt_facts_trg();
create trigger cf99_opt_del after delete on public.crm_options
  referencing old table as oldrows for each statement execute function public.crm_opt_facts_trg();
