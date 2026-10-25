-- =====================================================================
-- 51_companies_server.sql — the Companies list runs in the database
-- =====================================================================
-- Same as 50 did for Contacts: the Companies page stops downloading every
-- company, contact and deal; it asks only for the rows on screen and the
-- database filters, sorts, searches and counts.
--
--   company_facts           one row per company with what the list shows from
--                           other tables: types (CRM / Client / In sales /
--                           yours), sales status, pipelines, group (parent,
--                           number of subsidiaries), people, who can see it.
--                           Kept up to date by triggers.
--   companies_list(...)     one page / every matching id / the count
--   companies_rows(ids)     given companies in list format
--   companies_facets()      what the filters offer
--   companies_light()       id + name + group of every company (pickers)
--
-- Needs 50_contacts_server.sql first (it uses its helpers).
-- Nothing in your data is changed. Safe to run more than once.
-- Undo: 51_companies_server_undo.sql
-- =====================================================================

set search_path = public, extensions;

do $$ begin
  if to_regprocedure('public.list_cond_sql(text, text, jsonb)') is null then
    raise exception 'Run 50_contacts_server.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. company_facts
-- ---------------------------------------------------------------------
create table if not exists public.company_facts (
  company_id    uuid primary key references public.companies(id) on delete cascade,
  tenant_id     uuid not null,
  name_sort     text not null default '',
  search        text not null default '',
  types         text[] not null default '{crm}',
  type_sort     text   not null default '',
  status        text[] not null default '{none}',
  pipelines     text[] not null default '{}',
  parent_name   text,
  kids          int    not null default 0,
  contact_count int    not null default 0,
  contact_ids   uuid[] not null default '{}',
  assignees     uuid[] not null default '{}',
  refreshed_at  timestamptz not null default now()
);
alter table public.company_facts enable row level security;
drop policy if exists tenant_isolation on public.company_facts;
create policy tenant_isolation on public.company_facts for select using (tenant_id = (select public.current_tenant()));
grant select on public.company_facts to authenticated;

create index if not exists ix51_cof_tenant_name on public.company_facts (tenant_id, name_sort, company_id);
create index if not exists ix51_cof_types     on public.company_facts using gin (types);
create index if not exists ix51_cof_status    on public.company_facts using gin (status);
create index if not exists ix51_cof_pipes     on public.company_facts using gin (pipelines);
create index if not exists ix51_cof_contacts  on public.company_facts using gin (contact_ids);
create index if not exists ix51_cof_assignees on public.company_facts using gin (assignees);
do $$
declare ops text;
begin
  select quote_ident(n.nspname) || '.gin_trgm_ops' into ops
  from pg_opclass oc join pg_namespace n on n.oid = oc.opcnamespace where oc.opcname = 'gin_trgm_ops' limit 1;
  execute format('create index if not exists ix51_cof_search on public.company_facts using gin (search %s)', ops);
end $$;
create index if not exists ix51_companies_parent on public.companies (parent_id) where parent_id is not null;
create index if not exists ix51_companies_tenant_created on public.companies (tenant_id, created_at desc, id);

-- ---------------------------------------------------------------------
-- 2. work out the facts of some companies (the same rules as the app)
-- ---------------------------------------------------------------------
create or replace function public.cof_refresh(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;

  insert into public.company_facts as f (company_id, tenant_id, name_sort, search, types, type_sort, status, pipelines,
    parent_name, kids, contact_count, contact_ids, assignees, refreshed_at)
  with ids as materialized (select distinct k.id from unnest(p_ids) k(id) where k.id is not null),
  co as materialized (
    select c.id, c.tenant_id, c.name, c.parent_id,
           public.fx_norm(concat_ws(' ', c.name, c.legal_name, c.vat_number, c.street, c.city, c.province, c.country,
                                         c.postal_code, c.sector, c.source, c.email, c.website)) as search,
           case when jsonb_typeof(to_jsonb(c) -> 'relationship') = 'array' then to_jsonb(c) -> 'relationship' else '[]'::jsonb end as rel
    from ids join public.companies c on c.id = ids.id
  ),
  tenants as (select distinct tenant_id from co),
  win as materialized (select distinct pp.id from public.pipeline_phases pp where pp.sales_outcome = 'win'),
  live_tags as materialized (
    select distinct (to_jsonb(o) ->> 'tenant_id')::uuid as tenant_id, lower(o.label) as l from public.crm_options o
    where o.kind = 'relationship' and (to_jsonb(o) ->> 'tenant_id')::uuid in (select tenant_id from tenants)
  ),
  deal_agg as materialized (
    select z.company_id, bool_or(not z.won) as has_open, bool_or(z.won) as has_won,
           array_agg(distinct z.pipe order by z.pipe) filter (where z.pipe is not null and not z.won) as pipes
    from (
      select t.company_id, p.name as pipe, (coalesce(t.status, '') = 'won' or w.id is not null) as won
      from co
      join public.trackings t on t.company_id = co.id
      left join win w on w.id = t.current_phase_id
      left join public.pipelines p on p.id = t.pipeline_id) z
    group by z.company_id
  ),
  client_cos as materialized (select distinct cl.company_id from co join public.clients cl on cl.company_id = co.id),
  kids as (select k.parent_id, count(*)::int as n from co join public.companies k on k.parent_id = co.id group by k.parent_id),
  people as (
    select cc.company_id, count(distinct cc.contact_id)::int as n, array_agg(distinct cc.contact_id) as ids
    from co join public.company_contacts cc on cc.company_id = co.id group by cc.company_id
  ),
  asg as (
    select a.company_id, array_agg(distinct a.profile_id) as ids
    from co join public.company_assignees a on a.company_id = co.id group by a.company_id
  ),
  per as materialized (
    select co.*,
      (co.id in (select company_id from client_cos) or co.rel ? 'client') as is_client,
      (coalesce(d.has_open, false) or (co.rel ? 'sales' and not coalesce(d.has_won, false))) as is_sales,
      coalesce(d.pipes, '{}') as pipes,
      -- the company's own types, without the ones taken off the list in Settings
      coalesce((select array_agg(distinct x order by x) from jsonb_array_elements_text(co.rel) x
                where lower(x) in ('crm', 'client', 'sales')
                   or exists (select 1 from live_tags lt where lt.tenant_id = co.tenant_id and lt.l = lower(x))), '{}') as tags,
      (select p.name from public.companies p where p.id = co.parent_id) as parent_name,
      coalesce(k.n, 0) as kids, coalesce(pe.n, 0) as contact_count, coalesce(pe.ids, '{}') as contact_ids,
      coalesce(a.ids, '{}') as assignees
    from co
    left join deal_agg d on d.company_id = co.id
    left join kids k on k.parent_id = co.id
    left join people pe on pe.company_id = co.id
    left join asg a on a.company_id = co.id
  ),
  typed as (
    select p.*,
      array(select distinct t from unnest(array['crm'] || p.tags
              || case when p.is_client then array['client'] else '{}'::text[] end
              || case when p.is_sales then array['sales'] else '{}'::text[] end) t) as types
    from per p
  )
  select t.id, t.tenant_id, public.fx_norm(t.name), t.search,
         t.types,
         (case when 'client' = any(t.types) then '0' else '1' end) || (case when 'sales' = any(t.types) then '0' else '1' end)
           || coalesce(nullif(array_to_string(array(select lower(x) from unnest(t.types) x where x not in ('crm', 'client', 'sales') order by 1), ','), ''), '~'),
         case when t.is_client or t.is_sales
              then (case when t.is_client then array['client'] else '{}'::text[] end) || (case when t.is_sales then array['sales'] else '{}'::text[] end)
              else array['none'] end,
         t.pipes, t.parent_name, t.kids, t.contact_count, t.contact_ids, t.assignees, now()
  from typed t
  on conflict (company_id) do update set
    tenant_id = excluded.tenant_id, name_sort = excluded.name_sort, search = excluded.search, types = excluded.types,
    type_sort = excluded.type_sort, status = excluded.status, pipelines = excluded.pipelines, parent_name = excluded.parent_name,
    kids = excluded.kids, contact_count = excluded.contact_count, contact_ids = excluded.contact_ids,
    assignees = excluded.assignees, refreshed_at = excluded.refreshed_at;
end $$;
revoke all on function public.cof_refresh(uuid[]) from public, anon, authenticated;

create or replace function public.cof_refresh_tenants(p_tenants uuid[])
returns void language plpgsql security definer set search_path = public, extensions as $$
declare t uuid; ids uuid[]; last uuid;
begin
  foreach t in array coalesce(p_tenants, '{}') loop
    last := '00000000-0000-0000-0000-000000000000';
    loop
      select array_agg(id order by id) into ids from (
        select c.id from public.companies c where c.tenant_id = t and c.id > last order by c.id limit 5000) z;
      exit when ids is null;
      perform public.cof_refresh(ids);
      last := ids[cardinality(ids)];
    end loop;
  end loop;
end $$;
revoke all on function public.cof_refresh_tenants(uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. keep them up to date
-- ---------------------------------------------------------------------
create or replace function public.cof_trg_companies() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare ids uuid[] := '{}';
begin
  if tg_op in ('INSERT', 'UPDATE') then
    ids := ids || array(select id from newrows) || array(select parent_id from newrows where parent_id is not null);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    ids := ids || array(select parent_id from oldrows where parent_id is not null);
  end if;
  if tg_op = 'UPDATE' then
    -- a renamed company: its subsidiaries show the new parent name
    ids := ids || array(select k.id from public.companies k where k.parent_id in (select id from newrows));
  end if;
  perform public.cof_refresh(array(select distinct x from unnest(ids) x where x is not null));
  return null;
end $$;

create or replace function public.cof_trg_links() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare ids uuid[] := '{}';
begin
  if tg_op in ('INSERT', 'UPDATE') then
    ids := ids || array(select company_id from newrows where company_id is not null);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    ids := ids || array(select company_id from oldrows where company_id is not null);
  end if;
  perform public.cof_refresh(array(select distinct x from unnest(ids) x));
  return null;
end $$;

create or replace function public.cof_trg_deals() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare ids uuid[] := '{}';
begin
  if tg_op = 'INSERT' then
    ids := array(select company_id from newrows where company_id is not null);
  elsif tg_op = 'DELETE' then
    ids := array(select company_id from oldrows where company_id is not null);
  else
    ids := array(
      select n.company_id from newrows n join oldrows o on o.id = n.id
      where (n.status is distinct from o.status or n.current_phase_id is distinct from o.current_phase_id
          or n.company_id is distinct from o.company_id or n.pipeline_id is distinct from o.pipeline_id) and n.company_id is not null
      union
      select o.company_id from newrows n join oldrows o on o.id = n.id
      where n.company_id is distinct from o.company_id and o.company_id is not null);
  end if;
  perform public.cof_refresh(array(select distinct x from unnest(ids) x));
  return null;
end $$;

create or replace function public.cof_trg_tenant_wide() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare ts uuid[] := '{}';
begin
  if tg_op in ('INSERT', 'UPDATE') then
    ts := ts || array(select public.cf_row_tenant(to_jsonb(n)) from newrows n);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    ts := ts || array(select public.cf_row_tenant(to_jsonb(o)) from oldrows o);
  end if;
  perform public.cof_refresh_tenants(array(select distinct x from unnest(ts) x where x is not null));
  return null;
end $$;

-- ------------------------------------------------------------
-- the deals touched by a renamed pipeline / a phase whose Win flag changed
create or replace function public.fx_pipe_deals(p_pipes uuid[], p_phases uuid[])
returns table (deal_id uuid, company_id uuid)
language sql stable security definer set search_path = public as $$
  select t.id, t.company_id from public.trackings t where t.pipeline_id = any(coalesce(p_pipes, '{}'))
  union
  select t.id, t.company_id from public.trackings t where t.current_phase_id = any(coalesce(p_phases, '{}'))
$$;
revoke all on function public.fx_pipe_deals(uuid[], uuid[]) from public, anon, authenticated;

-- a renamed pipeline: swap the name inside the stored lists (no recalculation).
-- Returns the pipelines that still need a full recalculation: when another pipeline
-- of the company had the same old name, the lists can't tell them apart.
create or replace function public.fx_pipe_rename(p_tbl text, p_new jsonb, p_old jsonb)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare r record; slow uuid[] := '{}';
begin
  for r in
    select (n.e ->> 'id')::uuid as id, public.cf_row_tenant(n.e) as tenant, o.e ->> 'name' as old_name, n.e ->> 'name' as new_name
    from jsonb_array_elements(p_new) n(e) join jsonb_array_elements(p_old) o(e) on o.e ->> 'id' = n.e ->> 'id'
    where (n.e ->> 'name') is distinct from (o.e ->> 'name')
  loop
    if r.tenant is null or coalesce(r.old_name, '') = '' or coalesce(r.new_name, '') = ''
       or exists (select 1 from public.pipelines p where p.id <> r.id and p.name = r.old_name
                  and public.cf_row_tenant(to_jsonb(p)) = r.tenant) then
      slow := slow || r.id;
      continue;
    end if;
    execute format($q$update public.%I f set pipelines = array(select distinct x from unnest(array_replace(f.pipelines, $1, $2)) x order by 1)
                      where f.tenant_id = $3 and f.pipelines @> array[$1]$q$, p_tbl)
      using r.old_name, r.new_name, r.tenant;
  end loop;
  return slow;
end $$;
revoke all on function public.fx_pipe_rename(text, jsonb, jsonb) from public, anon, authenticated;

-- companies side
create or replace function public.cof_trg_pipes() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare pipes uuid[]; phases uuid[]; cos uuid[];
begin
  if tg_table_name = 'pipelines' then
    if not exists (select 1 from newrows n join oldrows o on o.id = n.id where n.name is distinct from o.name) then return null; end if;
    pipes := public.fx_pipe_rename('company_facts', (select jsonb_agg(to_jsonb(n)) from newrows n), (select jsonb_agg(to_jsonb(o)) from oldrows o));
  else
    phases := array(select n.id from newrows n join oldrows o on o.id = n.id where n.sales_outcome is distinct from o.sales_outcome);
  end if;
  if coalesce(cardinality(pipes), 0) + coalesce(cardinality(phases), 0) = 0 then return null; end if;
  cos := array(select distinct d.company_id from public.fx_pipe_deals(pipes, phases) d where d.company_id is not null);
  perform public.cof_refresh(cos);
  return null;
end $$;

do $$
declare t record;
begin
  for t in select tgname, c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where tgname like 'cof51\_%' loop
    execute format('drop trigger %I on public.%I', t.tgname, t.relname);
  end loop;
end $$;

create trigger cof51_co_ins after insert on public.companies referencing new table as newrows for each statement execute function public.cof_trg_companies();
create trigger cof51_co_upd after update on public.companies referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_companies();
create trigger cof51_co_del after delete on public.companies referencing old table as oldrows for each statement execute function public.cof_trg_companies();

create trigger cof51_cc_ins after insert on public.company_contacts referencing new table as newrows for each statement execute function public.cof_trg_links();
create trigger cof51_cc_upd after update on public.company_contacts referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_links();
create trigger cof51_cc_del after delete on public.company_contacts referencing old table as oldrows for each statement execute function public.cof_trg_links();

create trigger cof51_ca_ins after insert on public.company_assignees referencing new table as newrows for each statement execute function public.cof_trg_links();
create trigger cof51_ca_upd after update on public.company_assignees referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_links();
create trigger cof51_ca_del after delete on public.company_assignees referencing old table as oldrows for each statement execute function public.cof_trg_links();

create trigger cof51_cl_ins after insert on public.clients referencing new table as newrows for each statement execute function public.cof_trg_links();
create trigger cof51_cl_upd after update on public.clients referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_links();
create trigger cof51_cl_del after delete on public.clients referencing old table as oldrows for each statement execute function public.cof_trg_links();

create trigger cof51_deal_ins after insert on public.trackings referencing new table as newrows for each statement execute function public.cof_trg_deals();
create trigger cof51_deal_upd after update on public.trackings referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_deals();
create trigger cof51_deal_del after delete on public.trackings referencing old table as oldrows for each statement execute function public.cof_trg_deals();

-- pipelines / phases: only a rename or a Win flag change recalculates (see 55_pipeline_saves_fast.sql)
create trigger cof51_pipe_upd after update on public.pipelines referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_pipes();
create trigger cof51_phase_upd after update on public.pipeline_phases referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_pipes();
create trigger cof51_opt_ins after insert on public.crm_options referencing new table as newrows for each statement execute function public.cof_trg_tenant_wide();
create trigger cof51_opt_upd after update on public.crm_options referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_tenant_wide();
create trigger cof51_opt_del after delete on public.crm_options referencing old table as oldrows for each statement execute function public.cof_trg_tenant_wide();

-- ---------------------------------------------------------------------
-- 4. the list
-- ---------------------------------------------------------------------
create or replace function public.companies_fx(p_key text, p_type text, p_ctx jsonb default '{}')
returns text language plpgsql immutable as $$
declare k text := coalesce(p_key, '');
begin
  if k in ('name', 'legal_name', 'vat_number', 'website', 'linkedin', 'email', 'postal_code', 'notes') then return format('c.%I', k); end if;
  if k = 'phone' then return $s$case when coalesce(c.phone, '') <> '' then c.phone || coalesce(' · ext. ' || nullif(c.phone_ext, ''), '') end$s$; end if;
  if k = 'landline' then return $s$case when coalesce(c.landline, '') <> '' then c.landline || coalesce(' · ext. ' || nullif(c.landline_ext, ''), '') end$s$; end if;
  if k in ('sector', 'source') then return format('coalesce(c.%I, %L)', k, ''); end if;
  if k in ('city', 'province', 'country') then return format('btrim(coalesce(c.%I, %L))', k, ''); end if;
  if k = 'relationship' then return 'x.types'; end if;
  if k = 'status' then return 'x.status'; end if;
  if k = 'pipelines' then return 'x.pipelines'; end if;
  if k = 'address' then return $s$concat_ws(', ', nullif(c.street, ''), nullif(c.addr_number, ''), nullif(c.postal_code, ''), nullif(c.city, ''), nullif(c.province, ''), nullif(c.country, ''))$s$; end if;
  if k = 'street' then return $s$concat_ws(' ', nullif(c.street, ''), nullif(c.addr_number, ''))$s$; end if;
  if k = 'addr_complete' then return $s$(coalesce(c.street, '') <> '' and coalesce(c.postal_code, '') <> '' and coalesce(c.city, '') <> '' and coalesce(c.country, '') <> '')$s$; end if;
  if k = 'parent' then return $s$coalesce(c.parent_id::text, '')$s$; end if;
  if k = 'in_group' then return '(c.parent_id is not null or x.kids > 0)'; end if;
  if k = 'subsidiaries' then return 'x.kids'; end if;
  if k = 'contacts_count' then return 'x.contact_count'; end if;
  if k = 'contacts' then return 'x.contact_ids::text[]'; end if;
  if k = 'billing_set' then return $s$(coalesce(to_jsonb(c) #>> '{billing,name}', '') <> '' or coalesce(to_jsonb(c) #>> '{billing,email}', '') <> '' or coalesce(to_jsonb(c) #>> '{billing,phone}', '') <> '')$s$; end if;
  if k = 'billing_name' then return $s$(to_jsonb(c) #>> '{billing,name}')$s$; end if;
  if k = 'billing_email' then return $s$(to_jsonb(c) #>> '{billing,email}')$s$; end if;
  if k = 'visible_to' then return 'x.assignees::text[]'; end if;
  if k = 'created_by' then return $s$coalesce(c.created_by::text, '')$s$; end if;
  if k = 'created_at' then return 'c.created_at'; end if;
  if k = 'imported_at' then return $s$(to_jsonb(c) ->> 'imported_at')$s$; end if;
  if k = 'imported_by' then return $s$coalesce(to_jsonb(c) ->> 'imported_by', '')$s$; end if;
  if k ~ '^[0-9a-f-]{36}$' then
    if p_type = 'multi' then return format('public.fx_list(c.custom -> %L)', k); end if;
    if p_type = 'number' then return format('public.fx_num(c.custom ->> %L)', k); end if;
    if p_type = 'boolean' then return format('public.fx_bool(c.custom -> %L)', k); end if;
    return format('(c.custom ->> %L)', k);
  end if;
  return null;
end $$;

create or replace function public.companies_view_sql(p_view jsonb, p_search text, p_ctx jsonb, out w text, out o text)
language plpgsql immutable as $$
declare c jsonb; e text; s text; parts text[] := '{}'; ords text[] := '{}'; q text := btrim(public.fx_norm(p_search)); ty text; dir text;
begin
  for c in select * from jsonb_array_elements(case when jsonb_typeof(p_view -> 'conds') = 'array' then p_view -> 'conds' else '[]'::jsonb end) loop
    ty := coalesce(c ->> 'type', 'text');
    e := public.companies_fx(c ->> 'field', ty, p_ctx);
    if e is null then continue; end if;
    s := public.list_cond_sql(e, ty, c);
    if s is not null then parts := parts || ('(' || s || ')'); end if;
  end loop;
  w := case when cardinality(parts) = 0 then 'true'
            when p_view ->> 'match' = 'any' then '(' || array_to_string(parts, ' or ') || ')'
            else array_to_string(parts, ' and ') end;
  -- LIKE (not strpos) so the trigram index on search is used
  if q <> '' then w := w || format(' and x.search like %L', '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'); end if;

  for c in select * from jsonb_array_elements(case when jsonb_typeof(p_view -> 'sort') = 'array' then p_view -> 'sort' else '[]'::jsonb end) loop
    dir := case when c ->> 'dir' = 'desc' then 'desc' else 'asc' end;
    ty := coalesce(c ->> 'type', 'text');
    if c ->> 'key' = 'name' then e := 'x.name_sort';
    elsif c ->> 'key' = 'relationship' then e := 'x.type_sort';
    elsif c ->> 'key' = 'parent' then e := $s$nullif(public.fx_norm(x.parent_name), '')$s$;
    elsif c ->> 'key' = 'created_by' then e := $s$nullif(public.fx_norm((select concat_ws(' ', pr.first_name, pr.last_name) from public.profiles pr where pr.id = c.created_by)), '')$s$;
    else
      e := public.companies_fx(c ->> 'key', ty, p_ctx);
      if e is null then continue; end if;
      if ty = 'multi' then e := format('nullif(public.fx_norm(array_to_string(%s, %L)), %L)', e, ', ', '');
      elsif ty = 'number' then e := format('(%s)', e);
      elsif ty = 'boolean' then e := format('(case when coalesce(%s, false) then 1 else 0 end)', e);
      elsif ty = 'date' then e := format('(%s)', e);
      else e := format('nullif(public.fx_norm((%s)::text), %L)', e, '');
      end if;
    end if;
    ords := ords || format('%s %s nulls last', e, dir);
  end loop;
  o := array_to_string(ords || array['x.name_sort asc', 'c.id asc'], ', ');
end $$;

create or replace function public.company_row_json(p_id uuid)
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select (to_jsonb(c) - 'tenant_id') || jsonb_build_object(
    '__types', to_jsonb(x.types), '__status', to_jsonb(x.status), '__pipes', to_jsonb(x.pipelines),
    '__parentName', x.parent_name, '__kids', x.kids, '__count', x.contact_count, '__assignees', to_jsonb(x.assignees))
  from public.companies c join public.company_facts x on x.company_id = c.id
  where c.id = p_id
$$;
grant execute on function public.company_row_json(uuid) to authenticated;

create or replace function public.companies_list(
  p_view jsonb default '{}'::jsonb, p_search text default null,
  p_offset int default 0, p_limit int default 100, p_mode text default 'page', p_ctx jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security invoker
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  tenant uuid := public.current_tenant();
  lead boolean;
  v record;
  base text;
  total bigint;
  out jsonb;
begin
  if tenant is null then return jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'ids', '[]'::jsonb); end if;
  select (coalesce(p.is_superadmin, false) or p.role in ('boss', 'sales_manager')) into lead from public.profiles p where p.id = me;
  select * into v from public.companies_view_sql(p_view, p_search, p_ctx);
  base := format('from public.companies c join public.company_facts x on x.company_id = c.id
                  where c.tenant_id = %L and x.tenant_id = %L and (%s)%s',
                 tenant, tenant, v.w,
                 case when coalesce(lead, false) then '' else format(' and x.assignees @> array[%L::uuid]', me) end);
  execute 'select count(*) ' || base into total;
  if p_mode = 'count' then return jsonb_build_object('total', total); end if;
  if p_mode = 'ids' then
    execute format('select coalesce(jsonb_agg(z.id), %L) from (select c.id %s order by %s limit 200000) z', '[]', base, v.o) into out;
    return jsonb_build_object('total', total, 'ids', out);
  end if;
  execute format($q$
    select coalesce(jsonb_agg(public.company_row_json(z.id) order by z.n), '[]')
    from (select c.id, row_number() over () as n from (select c.id %s order by %s offset %s limit %s) c) z$q$,
    base, v.o, greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 100), 1), 500)) into out;
  return jsonb_build_object('total', total, 'rows', out);
end $$;
grant execute on function public.companies_list(jsonb, text, int, int, text, jsonb) to authenticated;

create or replace function public.companies_rows(p_ids uuid[])
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(public.company_row_json(k.id) order by k.ord) filter (where exists (select 1 from public.companies c where c.id = k.id)), '[]'::jsonb)
  from unnest(p_ids) with ordinality k(id, ord)
$$;
grant execute on function public.companies_rows(uuid[]) to authenticated;

-- id, name, group and logo site of every company you can see (pickers, group trees): small rows only
create or replace function public.companies_light()
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'parent_id', c.parent_id, 'website', c.website, 'legal_name', c.legal_name) order by c.name), '[]'::jsonb)
  from public.companies c where c.tenant_id = public.current_tenant()
$$;
grant execute on function public.companies_light() to authenticated;

create or replace function public.companies_facets()
returns jsonb language plpgsql stable security invoker set search_path = public, extensions as $$
declare tenant uuid := public.current_tenant(); out jsonb := '{}'::jsonb;
begin
  if tenant is null then return out; end if;
  out := jsonb_build_object(
    'sector',   (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(sector) v from public.companies where tenant_id = tenant and coalesce(btrim(sector), '') <> '' limit 2000) z),
    'source',   (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(source) v from public.companies where tenant_id = tenant and coalesce(btrim(source), '') <> '' limit 2000) z),
    'city',     (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(city) v from public.companies where tenant_id = tenant and coalesce(btrim(city), '') <> '' limit 5000) z),
    'province', (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(province) v from public.companies where tenant_id = tenant and coalesce(btrim(province), '') <> '' limit 5000) z),
    'country',  (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(country) v from public.companies where tenant_id = tenant and coalesce(btrim(country), '') <> '' limit 2000) z),
    'pipelines',(select coalesce(jsonb_agg(v order by v), '[]') from (select distinct name v from public.pipelines where coalesce(name, '') <> '') z),
    -- companies at the top of a group or in the middle (the "Parent company" filter)
    'parents',  (select coalesce(jsonb_agg(jsonb_build_object('value', p.id, 'label', p.name) order by p.name), '[]')
                 from public.companies p where p.tenant_id = tenant and exists (select 1 from public.companies k where k.parent_id = p.id)),
    -- people (the "Contacts" filter): the first 20,000 by name
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('value', z.id, 'label', z.label) order by z.label), '[]') from (
                   select ct.id, coalesce(nullif(concat_ws(' ', nullif(ct.first_name, ''), nullif(ct.last_name, '')), ''), ct.email, 'Unnamed') as label
                   from public.contacts ct where ct.tenant_id = tenant order by 2 limit 20000) z)
  );
  out := out || jsonb_build_object('custom', coalesce((
    select jsonb_object_agg(f.id::text, (
      select coalesce(jsonb_agg(distinct v), '[]') from (
        select unnest(public.fx_list(c.custom -> f.id::text)) v from public.companies c
        where c.tenant_id = tenant and c.custom ? f.id::text limit 20000) z))
    from public.company_fields f where f.type = 'multiselect'), '{}'::jsonb));
  return out;
end $$;
grant execute on function public.companies_facets() to authenticated;

-- ---------------------------------------------------------------------
-- 5. fill company_facts for every company
-- ---------------------------------------------------------------------
do $$
declare ts uuid[];
begin
  select array_agg(distinct tenant_id) into ts from public.companies where tenant_id is not null;
  perform public.cof_refresh_tenants(ts);
  delete from public.company_facts f where not exists (select 1 from public.companies c where c.id = f.company_id);
end $$;
analyze public.company_facts;

select count(*) as companies_ready,
       count(*) filter (where 'client' = any(status)) as clients,
       count(*) filter (where 'sales' = any(status)) as in_sales,
       count(*) filter (where kids > 0) as top_of_a_group
from public.company_facts;
