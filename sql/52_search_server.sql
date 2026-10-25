-- =====================================================================
-- 52_search_server.sql — search contacts, companies and deals in the database
-- =====================================================================
-- The search box (Home, ⌘K) and the pickers of tickets ("Requester",
-- "Linked to company / deal", mail rules) used to download every contact,
-- company and deal to look through them in the browser. With this file they
-- ask the database, which answers with the best few matches.
--
--   global_search(text, kinds, limit)   best matches per kind
--
-- Needs 50_contacts_server.sql and 51_companies_server.sql first.
-- Nothing in your data is changed. Safe to run more than once.
-- Undo: drop function public.global_search(text, text[], int); drop function public.pipeline_summary();
-- =====================================================================
set search_path = public, extensions;

do $$ begin
  if to_regclass('public.contact_facts') is null or to_regclass('public.company_facts') is null then
    raise exception 'Run 50_contacts_server.sql and 51_companies_server.sql first.';
  end if;
end $$;

-- deals are found by their name (trigram index on the name as compared)
do $$
declare ops text;
begin
  select quote_ident(n.nspname) || '.gin_trgm_ops' into ops
  from pg_opclass oc join pg_namespace n on n.oid = oc.opcnamespace where oc.opcname = 'gin_trgm_ops' limit 1;
  execute format('create index if not exists ix52_trackings_name_trgm on public.trackings using gin (public.fx_norm(deal_name) %s)', ops);
end $$;

-- names that start with what you type: found straight from an index
create index if not exists ix52_cf_prefix  on public.contact_facts (tenant_id, name_sort text_pattern_ops);
create index if not exists ix52_cof_prefix on public.company_facts (tenant_id, name_sort text_pattern_ops);

create or replace function public.global_search(p_q text, p_kinds text[] default array['contact', 'company', 'deal'], p_limit int default 8)
returns jsonb
language plpgsql stable security invoker
set search_path = public, extensions
as $$
declare
  q text := btrim(public.fx_norm(p_q));
  pat text;
  tenant uuid := public.current_tenant();
  me uuid := auth.uid();
  lead boolean;
  lim int := least(greatest(coalesce(p_limit, 8), 1), 50);
  out jsonb := '[]'::jsonb;
begin
  if q = '' or tenant is null then return out; end if;
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select (coalesce(p.is_superadmin, false) or p.role in ('boss', 'sales_manager')) into lead from public.profiles p where p.id = me;

  if 'contact' = any(p_kinds) then
    out := out || coalesce((
      select jsonb_agg(jsonb_build_object('kind', 'contact', 'id', z.id, 'label', z.label, 'sub', z.sub, 'email', z.email) order by z.rank, z.label)
      from (
        select c.id, coalesce(nullif(concat_ws(' ', nullif(c.first_name, ''), nullif(c.last_name, '')), ''), c.email, 'Contact') as label,
               nullif(concat_ws(' · ', nullif(c.position, ''), nullif(c.email, ''), nullif(x.company_names[1], '')), '') as sub,
               c.email,
               case when x.name_sort like q || '%' then 0 when x.name_sort like '% ' || q || '%' then 1 else 2 end as rank
        from (
          -- names starting with it (index), then anything containing it — never the whole list
          (select f.* from public.contact_facts f where f.tenant_id = tenant and f.name_sort like replace(pat, '%', '') || '%'
             and (coalesce(lead, false) or f.assignees @> array[me]) order by f.name_sort limit lim)
          union
          (select f.* from public.contact_facts f where f.tenant_id = tenant and f.search like pat
             and (coalesce(lead, false) or f.assignees @> array[me]) limit lim * 4)
        ) x join public.contacts c on c.id = x.contact_id
        order by rank, x.name_sort limit lim) z), '[]'::jsonb);
  end if;

  if 'company' = any(p_kinds) then
    out := out || coalesce((
      select jsonb_agg(jsonb_build_object('kind', 'company', 'id', z.id, 'label', z.name, 'sub', z.sub) order by z.rank, z.name)
      from (
        select c.id, c.name,
               coalesce(nullif(c.legal_name, c.name), nullif(concat_ws(', ', nullif(c.city, ''), nullif(c.country, '')), ''), 'Company') as sub,
               case when x.name_sort like q || '%' then 0 when x.name_sort like '% ' || q || '%' then 1 else 2 end as rank
        from (
          (select f.* from public.company_facts f where f.tenant_id = tenant and f.name_sort like replace(pat, '%', '') || '%'
             and (coalesce(lead, false) or f.assignees @> array[me]) order by f.name_sort limit lim)
          union
          (select f.* from public.company_facts f where f.tenant_id = tenant and f.search like pat
             and (coalesce(lead, false) or f.assignees @> array[me]) limit lim * 4)
        ) x join public.companies c on c.id = x.company_id
        order by rank, x.name_sort limit lim) z), '[]'::jsonb);
  end if;

  if 'deal' = any(p_kinds) then
    -- by the deal's name, or by its company's name (row security decides which deals you see)
    out := out || coalesce((
      select jsonb_agg(jsonb_build_object('kind', 'deal', 'id', z.id, 'label', z.label, 'sub', z.sub, 'status', z.status) order by z.rank, z.label)
      from (
        select t.id, coalesce(nullif(btrim(t.deal_name), ''), co.name, 'Deal') as label,
               nullif(concat_ws(' · ', co.name, case t.status when 'paused' then 'hold' else t.status end), '') as sub,
               t.status,
               case when public.fx_norm(t.deal_name) like q || '%' then 0 when t.status = 'active' then 1 else 2 end as rank
        from public.trackings t
        left join public.companies co on co.id = t.company_id
        where t.id in (
          (select t2.id from public.trackings t2 where t2.tenant_id = tenant and public.fx_norm(t2.deal_name) like pat limit lim * 4)
          union
          (select t3.id from public.trackings t3 where t3.tenant_id = tenant
             and t3.company_id in (select x.company_id from public.company_facts x where x.tenant_id = tenant and x.name_sort like pat limit 50)
           limit lim * 4))
        order by rank, label limit lim) z), '[]'::jsonb);
  end if;
  return out;
end $$;
grant execute on function public.global_search(text, text[], int) to authenticated;

-- ---------------------------------------------------------------------
-- The pipeline card on Home: counted here instead of downloading every deal
-- ---------------------------------------------------------------------
create or replace function public.pipeline_summary()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'active', count(*) filter (where t.status = 'active'),
    'won',    count(*) filter (where t.status = 'won'),
    'value',  coalesce(sum(coalesce(public.fx_num(t.product_price::text), 0)) filter (where t.status = 'active'), 0),
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object('phase_id', z.current_phase_id, 'count', z.n, 'value', z.v))
      from (select t2.current_phase_id, count(*) as n, coalesce(sum(coalesce(public.fx_num(t2.product_price::text), 0)), 0) as v
            from public.trackings t2
            where t2.tenant_id = public.current_tenant() and t2.status = 'active' and t2.current_phase_id is not null
            group by t2.current_phase_id) z), '[]'::jsonb))
  from public.trackings t
  where t.tenant_id = public.current_tenant()
$$;
grant execute on function public.pipeline_summary() to authenticated;

select 'Search ready' as done;
