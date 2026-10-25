-- =====================================================================
-- 50_contacts_server.sql — the Contacts list runs in the database
-- =====================================================================
-- Until now the Contacts page downloaded EVERY contact, company, link and
-- deal (≈40 MB for 22,000 contacts) and filtered them in the browser. That
-- can't grow to hundreds of thousands of contacts. With this file the page
-- asks the database only for the rows on screen; filters, sorting, search
-- and counts are done here.
--
--   contact_facts            one row per contact with everything the list
--                            shows or filters on that comes from OTHER
--                            tables: companies, types (CRM / Client / In
--                            sales / Partner…), pipelines, company sector,
--                            city and fields, who can see it. Kept up to date
--                            automatically by triggers on every table
--                            involved, so it is never stale.
--   contacts_list(...)       one page of the list (or every matching id),
--                            with any saved view / filters / sort / search.
--   contacts_rows(ids)       given contacts in list format.
--   contacts_facets()        the values the filters offer (cities, sectors…).
--
-- Nothing in your data is changed. Safe to run more than once (it rebuilds
-- contact_facts at the end; ~20 s per 100,000 contacts).
-- Undo: 50_contacts_server_undo.sql
-- =====================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- 0. small helpers
-- ---------------------------------------------------------------------
-- text for comparing: lower case, no accents ("Íñigo" = "inigo")
create or replace function public.fx_norm(s text) returns text
language sql immutable parallel safe as $$
  -- the same as the app: decompose, drop every accent mark (U+0300–U+036F), lower case
  select lower(regexp_replace(normalize(coalesce(s, ''), NFD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g'))
$$;
-- a list value (["a","b"] or "a; b") → text[]  (same as customList in the app)
create or replace function public.fx_list(v jsonb) returns text[]
language sql immutable parallel safe as $$
  select case
    when v is null or v = 'null'::jsonb then '{}'::text[]
    when jsonb_typeof(v) = 'array' then coalesce(array(select x from jsonb_array_elements_text(v) x where btrim(x) <> ''), '{}')
    when btrim(v #>> '{}') = '' then '{}'::text[]
    else coalesce(array(select x from regexp_split_to_table(v #>> '{}', '\s*[;,]\s*') x where x <> ''), '{}')
  end
$$;
create or replace function public.fx_num(s text) returns numeric
language plpgsql immutable parallel safe as $$
begin
  if s is null or btrim(s) = '' then return null; end if;
  return s::numeric;
exception when others then return null;
end $$;
create or replace function public.fx_bool(v jsonb) returns boolean
language sql immutable parallel safe as $$
  select case when v is null then false
              when jsonb_typeof(v) = 'boolean' then v::text::boolean
              when jsonb_typeof(v) = 'string' then lower(v #>> '{}') in ('true', 'yes', 'si', 'sí', '1')
              when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric <> 0
              else false end
$$;

-- ---------------------------------------------------------------------
-- 1. contact_facts
-- ---------------------------------------------------------------------
create table if not exists public.contact_facts (
  contact_id    uuid primary key references public.contacts(id) on delete cascade,
  tenant_id     uuid not null,
  name_sort     text not null default '',
  search        text not null default '',
  company_ids   uuid[] not null default '{}',
  company_names text[] not null default '{}',
  types         text[] not null default '{crm}',
  types_from    jsonb  not null default '{}',
  type_sort     text   not null default '',
  status        text[] not null default '{none}',
  pipelines     text[] not null default '{}',
  co_sectors    text[] not null default '{}',
  co_cities     text[] not null default '{}',
  co_custom     jsonb  not null default '{}',
  assignees     uuid[] not null default '{}',
  refreshed_at  timestamptz not null default now()
);
alter table public.contact_facts enable row level security;
drop policy if exists tenant_isolation on public.contact_facts;
create policy tenant_isolation on public.contact_facts for select using (tenant_id = (select public.current_tenant()));
grant select on public.contact_facts to authenticated;

create index if not exists ix50_cf_tenant_name on public.contact_facts (tenant_id, name_sort, contact_id);
create index if not exists ix50_cf_types     on public.contact_facts using gin (types);
create index if not exists ix50_cf_status    on public.contact_facts using gin (status);
create index if not exists ix50_cf_pipes     on public.contact_facts using gin (pipelines);
create index if not exists ix50_cf_companies on public.contact_facts using gin (company_ids);
create index if not exists ix50_cf_assignees on public.contact_facts using gin (assignees);
do $$
declare ops text;
begin
  select quote_ident(n.nspname) || '.gin_trgm_ops' into ops
  from pg_opclass oc join pg_namespace n on n.oid = oc.opcnamespace where oc.opcname = 'gin_trgm_ops' limit 1;
  if ops is null then
    begin create extension if not exists pg_trgm with schema extensions;
    exception when others then create extension if not exists pg_trgm; end;
    select quote_ident(n.nspname) || '.gin_trgm_ops' into ops
    from pg_opclass oc join pg_namespace n on n.oid = oc.opcnamespace where oc.opcname = 'gin_trgm_ops' limit 1;
  end if;
  execute format('create index if not exists ix50_cf_search on public.contact_facts using gin (search %s)', ops);
end $$;
-- the plain contact columns the list sorts on, per tenant
create index if not exists ix50_contacts_tenant_created on public.contacts (tenant_id, created_at desc, id);

-- ---------------------------------------------------------------------
-- 2. work out the facts of some contacts (same rules as the app had)
-- ---------------------------------------------------------------------
create or replace function public.cf_refresh(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;

  -- everything is aggregated per company / per contact (no per-row lookups), so a batch of
  -- thousands of contacts costs about the same as reading their rows once
  insert into public.contact_facts as f (contact_id, tenant_id, name_sort, search, company_ids, company_names,
    types, types_from, type_sort, status, pipelines, co_sectors, co_cities, co_custom, assignees, refreshed_at)
  with ids as materialized (select distinct k.id from unnest(p_ids) k(id) where k.id is not null),
  ct as materialized (
    select c.id, c.tenant_id, c.first_name, c.last_name, c.position, c.email, c.phone, c.city, c.province
    from ids join public.contacts c on c.id = ids.id
  ),
  tenants as (select distinct tenant_id from ct),
  win as materialized (          -- the "won" phases (ids are unique, so no tenant filter is needed)
    select distinct pp.id from public.pipeline_phases pp where pp.sales_outcome = 'win'
  ),
  live_tags as materialized (   -- your own company types still on the list (Settings): removed ones disappear
    select distinct (to_jsonb(o) ->> 'tenant_id')::uuid as tenant_id, lower(o.label) as l from public.crm_options o
    where o.kind = 'relationship' and (to_jsonb(o) ->> 'tenant_id')::uuid in (select tenant_id from tenants)
  ),
  links as materialized (
    select cc.contact_id, co.id as company_id, co.name, co.tenant_id,
           nullif(btrim(coalesce(co.sector, '')), '') as sector, nullif(btrim(coalesce(co.city, '')), '') as city,
           coalesce(co.custom, '{}'::jsonb) as custom,
           case when jsonb_typeof(to_jsonb(co) -> 'relationship') = 'array' then to_jsonb(co) -> 'relationship' else '[]'::jsonb end as rel
    from ids
    join public.company_contacts cc on cc.contact_id = ids.id
    join public.companies co on co.id = cc.company_id
  ),
  cos as materialized (select distinct on (company_id) company_id, tenant_id, rel from links),
  my_deals as materialized (     -- the deals these people are on themselves
    select tc.contact_id, p.name as pipe,
           (coalesce(t.status, '') = 'won' or w.id is not null) as won
    from ids
    join public.tracking_contacts tc on tc.contact_id = ids.id
    join public.trackings t on t.id = tc.tracking_id
    left join win w on w.id = t.current_phase_id
    left join public.pipelines p on p.id = t.pipeline_id
  ),
  deal_agg as materialized (     -- per company: open deals, any won deal, pipelines of the open ones
    select z.company_id, bool_or(not z.won) as has_open, bool_or(z.won) as has_won,
           array_agg(distinct z.pipe) filter (where z.pipe is not null and not z.won) as pipes
    from (
      select t.company_id, p.name as pipe, (coalesce(t.status, '') = 'won' or w.id is not null) as won
      from cos
      join public.trackings t on t.company_id = cos.company_id
      left join win w on w.id = t.current_phase_id
      left join public.pipelines p on p.id = t.pipeline_id) z
    group by z.company_id
  ),
  client_cos as materialized (
    select distinct cl.company_id from cos join public.clients cl on cl.company_id = cos.company_id
  ),
  co_status as materialized (
    select s.company_id,
           (s.company_id in (select company_id from client_cos) or s.rel ? 'client') as client,
           (coalesce(d.has_open, false) or (s.rel ? 'sales' and not coalesce(d.has_won, false))) as sales,
           coalesce(d.pipes, '{}') as pipes,
           coalesce((select array_agg(distinct x) from jsonb_array_elements_text(s.rel) x
                     where lower(x) not in ('crm', 'client', 'sales')
                       and exists (select 1 from live_tags lt where lt.tenant_id = s.tenant_id and lt.l = lower(x))), '{}') as own
    from cos s left join deal_agg d on d.company_id = s.company_id
  ),
  lk as materialized (           -- every link with its company's status
    select l.*, s.client, s.sales, s.pipes, s.own from links l join co_status s on s.company_id = l.company_id
  ),
  per_links as (
    select l.contact_id,
           array_agg(l.company_id order by l.name, l.company_id) as company_ids,
           array_agg(l.name order by l.name, l.company_id) as company_names,
           bool_or(l.client) as client, bool_or(l.sales) as sales,
           coalesce(array_agg(distinct l.sector) filter (where l.sector is not null), '{}') as co_sectors,
           coalesce(array_agg(distinct l.city) filter (where l.city is not null), '{}') as co_cities,
           to_jsonb(array_agg(distinct l.name)) as from_crm,
           to_jsonb(array_agg(distinct l.name) filter (where l.client)) as from_client,
           to_jsonb(array_agg(distinct l.name) filter (where l.sales)) as from_sales
    from lk l group by l.contact_id
  ),
  per_pipes as (
    select z.contact_id, array_agg(distinct z.p order by z.p) as pipes from (
      select l.contact_id, unnest(l.pipes) as p from lk l
      union
      select d.contact_id, d.pipe from my_deals d where not d.won and d.pipe is not null
    ) z group by z.contact_id
  ),
  own_open as (                  -- contacts on an open deal themselves
    select distinct d.contact_id from my_deals d where not d.won
  ),
  client_people as materialized (   -- people listed on clients (ids, or {sourceId} / {contact_id})
    select distinct z.cid::uuid as cid from (
      select coalesce(e ->> 'sourceId', e ->> 'contact_id', case when jsonb_typeof(e) = 'string' then e #>> '{}' end) as cid
      from public.clients cl
      cross join lateral jsonb_array_elements(case when jsonb_typeof(cl.contacts) = 'array' then cl.contacts else '[]'::jsonb end) e
      where (to_jsonb(cl) ->> 'tenant_id')::uuid in (select tenant_id from tenants)) z
    where z.cid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  per_own as (                   -- your own types (Partner…) and the companies each comes from
    select z.contact_id, array_agg(z.tag order by lower(z.tag)) as own, jsonb_object_agg(z.tag, z.names) as from_own from (
      select l.contact_id, t as tag, to_jsonb(array_agg(distinct l.name)) as names
      from lk l cross join lateral unnest(l.own) t group by l.contact_id, t) z
    group by z.contact_id
  ),
  co_fields as materialized (
    select f.id::text as fid, f.type, (to_jsonb(f) ->> 'tenant_id')::uuid as tenant_id from public.company_fields f
    where (to_jsonb(f) ->> 'tenant_id')::uuid in (select tenant_id from tenants)
  ),
  per_cofields as (
    select z.contact_id, jsonb_object_agg(z.fid, z.vals) as co_custom from (
      select l.contact_id, cf.fid, to_jsonb(array_agg(distinct v order by v)) as vals
      from lk l
      join co_fields cf on cf.tenant_id = l.tenant_id and l.custom ? cf.fid
      cross join lateral unnest(case
          when cf.type = 'multiselect' then public.fx_list(l.custom -> cf.fid)
          when cf.type = 'boolean' then case when public.fx_bool(l.custom -> cf.fid) then array['true'] else '{}'::text[] end
          when coalesce(l.custom ->> cf.fid, '') <> '' then array[l.custom ->> cf.fid]
          else '{}'::text[] end) v
      group by l.contact_id, cf.fid) z
    group by z.contact_id
  ),
  per_assign as (
    select a.contact_id, array_agg(distinct a.profile_id) as assignees
    from ids join public.contact_assignees a on a.contact_id = ids.id group by a.contact_id
  ),
  per as materialized (
    select ct.*,
      coalesce(pl.company_ids, '{}') as company_ids, coalesce(pl.company_names, '{}') as company_names,
      (coalesce(pl.client, false) or cp.cid is not null) as is_client,
      (coalesce(pl.sales, false) or oo.contact_id is not null) as is_sales,
      coalesce(pp.pipes, '{}') as pipes,
      coalesce(po.own, '{}') as own,
      jsonb_strip_nulls(jsonb_build_object('crm', pl.from_crm, 'client', pl.from_client, 'sales', pl.from_sales)) || coalesce(po.from_own, '{}') as types_from,
      coalesce(pl.co_sectors, '{}') as co_sectors, coalesce(pl.co_cities, '{}') as co_cities,
      coalesce(pc.co_custom, '{}') as co_custom,
      coalesce(pa.assignees, '{}') as assignees
    from ct
    left join per_links pl on pl.contact_id = ct.id
    left join per_pipes pp on pp.contact_id = ct.id
    left join per_own po on po.contact_id = ct.id
    left join per_cofields pc on pc.contact_id = ct.id
    left join per_assign pa on pa.contact_id = ct.id
    left join client_people cp on cp.cid = ct.id
    left join own_open oo on oo.contact_id = ct.id
  )
  select p.id, p.tenant_id,
         public.fx_norm(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))),
         public.fx_norm(concat_ws(' ', p.first_name, p.last_name, p.position, p.email, p.phone, p.city, p.province, array_to_string(p.company_names, ' '))),
         p.company_ids, p.company_names,
         array['crm'] || case when p.is_client then array['client'] else '{}'::text[] end
                      || case when p.is_sales then array['sales'] else '{}'::text[] end || p.own,
         p.types_from,
         (case when p.is_client then '0' else '1' end) || (case when p.is_sales then '0' else '1' end)
           || coalesce(nullif(array_to_string(array(select lower(x) from unnest(p.own) x order by 1), ','), ''), '~'),
         case when p.is_client or p.is_sales
              then (case when p.is_client then array['client'] else '{}'::text[] end) || (case when p.is_sales then array['sales'] else '{}'::text[] end)
              else array['none'] end,
         p.pipes, p.co_sectors, p.co_cities, p.co_custom, p.assignees, now()
  from per p
  on conflict (contact_id) do update set
    tenant_id = excluded.tenant_id, name_sort = excluded.name_sort, search = excluded.search,
    company_ids = excluded.company_ids, company_names = excluded.company_names, types = excluded.types,
    types_from = excluded.types_from, type_sort = excluded.type_sort, status = excluded.status,
    pipelines = excluded.pipelines, co_sectors = excluded.co_sectors, co_cities = excluded.co_cities,
    co_custom = excluded.co_custom, assignees = excluded.assignees, refreshed_at = excluded.refreshed_at;
end $$;
revoke all on function public.cf_refresh(uuid[]) from public, anon, authenticated;

-- contacts of some companies
create or replace function public.cf_refresh_companies(p_company_ids uuid[])
returns void language plpgsql security definer set search_path = public, extensions as $$
declare ids uuid[];
begin
  if p_company_ids is null or cardinality(p_company_ids) = 0 then return; end if;
  select array_agg(distinct cc.contact_id) into ids from public.company_contacts cc where cc.company_id = any(p_company_ids);
  perform public.cf_refresh(ids);
end $$;
revoke all on function public.cf_refresh_companies(uuid[]) from public, anon, authenticated;

-- every contact of some tenants (after a type / pipeline / company field changes), in chunks
create or replace function public.cf_refresh_tenants(p_tenants uuid[])
returns void language plpgsql security definer set search_path = public, extensions as $$
declare t uuid; ids uuid[]; last uuid;
begin
  foreach t in array coalesce(p_tenants, '{}') loop
    last := '00000000-0000-0000-0000-000000000000';
    loop
      select array_agg(id order by id) into ids from (
        select c.id from public.contacts c where c.tenant_id = t and c.id > last order by c.id limit 5000) z;
      exit when ids is null;
      perform public.cf_refresh(ids);
      last := ids[cardinality(ids)];
    end loop;
  end loop;
end $$;
revoke all on function public.cf_refresh_tenants(uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. keep the facts up to date (one statement = one refresh, also for imports)
-- ---------------------------------------------------------------------
create or replace function public.cf_trg_contacts() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.cf_refresh(array(select id from newrows));
  return null;
end $$;

create or replace function public.cf_trg_links() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  -- company_contacts, contact_assignees, tracking_contacts: the contact ids on both sides
  if tg_op = 'INSERT' then
    perform public.cf_refresh(array(select distinct contact_id from newrows where contact_id is not null));
  elsif tg_op = 'DELETE' then
    perform public.cf_refresh(array(select distinct contact_id from oldrows where contact_id is not null));
  else
    perform public.cf_refresh(array(select contact_id from newrows where contact_id is not null union select contact_id from oldrows where contact_id is not null));
  end if;
  return null;
end $$;

create or replace function public.cf_trg_companies() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'UPDATE' then
    -- only when something the contact list shows changed
    perform public.cf_refresh_companies(array(
      select n.id from newrows n join oldrows o on o.id = n.id
      where n.name is distinct from o.name or n.sector is distinct from o.sector or n.city is distinct from o.city
         or n.custom is distinct from o.custom
         or (to_jsonb(n) -> 'relationship') is distinct from (to_jsonb(o) -> 'relationship')));
  end if;
  return null;
end $$;

create or replace function public.cf_trg_deals() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare cos uuid[]; deals uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct company_id), array_agg(id) into cos, deals from newrows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct company_id), array_agg(id) into cos, deals from oldrows;
  else
    -- a renamed deal changes nothing on the contact list: only status / phase / company / pipeline
    select array_agg(distinct x.company_id), array_agg(distinct x.id) into cos, deals from (
      select n.company_id, n.id from newrows n join oldrows o on o.id = n.id
      where n.status is distinct from o.status or n.current_phase_id is distinct from o.current_phase_id
         or n.company_id is distinct from o.company_id or n.pipeline_id is distinct from o.pipeline_id
      union
      select o.company_id, o.id from newrows n join oldrows o on o.id = n.id
      where n.company_id is distinct from o.company_id) x;
  end if;
  if deals is null then return null; end if;
  perform public.cf_refresh(array(
    select cc.contact_id from public.company_contacts cc where cc.company_id = any(cos)
    union
    select tc.contact_id from public.tracking_contacts tc where tc.tracking_id = any(deals)));
  return null;
end $$;

create or replace function public.cf_client_people(v jsonb) returns uuid[]
language sql immutable as $$
  select coalesce(array_agg(z.cid::uuid), '{}') from (
    select coalesce(e ->> 'sourceId', e ->> 'contact_id', case when jsonb_typeof(e) = 'string' then e #>> '{}' end) as cid
    from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end) e) z
  where z.cid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

create or replace function public.cf_row_tenant(j jsonb) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((j ->> 'tenant_id')::uuid,
                  (select (to_jsonb(p) ->> 'tenant_id')::uuid from public.pipelines p where p.id = (j ->> 'pipeline_id')::uuid))
$$;

create or replace function public.cf_trg_clients() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare cos uuid[] := '{}'; people uuid[] := '{}'; r record;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    for r in select company_id, contacts from newrows loop
      if r.company_id is not null then cos := cos || r.company_id; end if;
      people := people || public.cf_client_people(r.contacts);
    end loop;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    for r in select company_id, contacts from oldrows loop
      if r.company_id is not null then cos := cos || r.company_id; end if;
      people := people || public.cf_client_people(r.contacts);
    end loop;
  end if;
  perform public.cf_refresh(array(
    select cc.contact_id from public.company_contacts cc where cc.company_id = any(cos)
    union select unnest(people)));
  return null;
end $$;

create or replace function public.cf_trg_tenant_wide() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare ts uuid[] := '{}';
begin
  if tg_op in ('INSERT', 'UPDATE') then
    ts := ts || array(select public.cf_row_tenant(to_jsonb(n)) from newrows n);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    ts := ts || array(select public.cf_row_tenant(to_jsonb(o)) from oldrows o);
  end if;
  perform public.cf_refresh_tenants(array(select distinct x from unnest(ts) x where x is not null));
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

-- contacts side
create or replace function public.cf_trg_pipes() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare pipes uuid[]; phases uuid[]; deals uuid[]; cos uuid[];
begin
  if tg_table_name = 'pipelines' then
    if not exists (select 1 from newrows n join oldrows o on o.id = n.id where n.name is distinct from o.name) then return null; end if;
    pipes := public.fx_pipe_rename('contact_facts', (select jsonb_agg(to_jsonb(n)) from newrows n), (select jsonb_agg(to_jsonb(o)) from oldrows o));
  else
    phases := array(select n.id from newrows n join oldrows o on o.id = n.id where n.sales_outcome is distinct from o.sales_outcome);
  end if;
  if coalesce(cardinality(pipes), 0) + coalesce(cardinality(phases), 0) = 0 then return null; end if;
  select array_agg(d.deal_id), array_agg(distinct d.company_id) filter (where d.company_id is not null)
    into deals, cos from public.fx_pipe_deals(pipes, phases) d;
  if deals is null then return null; end if;
  perform public.cf_refresh(array(
    select cc.contact_id from public.company_contacts cc where cc.company_id = any(coalesce(cos, '{}'))
    union
    select tc.contact_id from public.tracking_contacts tc where tc.tracking_id = any(deals)));
  return null;
end $$;

do $$
declare t record;
begin
  -- drop old versions first (re-runs)
  for t in select tgname, c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where tgname like 'cf50\_%' loop
    execute format('drop trigger %I on public.%I', t.tgname, t.relname);
  end loop;
end $$;

create trigger cf50_contacts_ins after insert on public.contacts referencing new table as newrows for each statement execute function public.cf_trg_contacts();
create trigger cf50_contacts_upd after update on public.contacts referencing new table as newrows for each statement execute function public.cf_trg_contacts();

create trigger cf50_cc_ins after insert on public.company_contacts referencing new table as newrows for each statement execute function public.cf_trg_links();
create trigger cf50_cc_upd after update on public.company_contacts referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_links();
create trigger cf50_cc_del after delete on public.company_contacts referencing old table as oldrows for each statement execute function public.cf_trg_links();

create trigger cf50_tc_ins after insert on public.tracking_contacts referencing new table as newrows for each statement execute function public.cf_trg_links();
create trigger cf50_tc_upd after update on public.tracking_contacts referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_links();
create trigger cf50_tc_del after delete on public.tracking_contacts referencing old table as oldrows for each statement execute function public.cf_trg_links();

create trigger cf50_ca_ins after insert on public.contact_assignees referencing new table as newrows for each statement execute function public.cf_trg_links();
create trigger cf50_ca_upd after update on public.contact_assignees referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_links();
create trigger cf50_ca_del after delete on public.contact_assignees referencing old table as oldrows for each statement execute function public.cf_trg_links();

create trigger cf50_co_upd after update on public.companies referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_companies();

create trigger cf50_deal_ins after insert on public.trackings referencing new table as newrows for each statement execute function public.cf_trg_deals();
create trigger cf50_deal_upd after update on public.trackings referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_deals();
create trigger cf50_deal_del after delete on public.trackings referencing old table as oldrows for each statement execute function public.cf_trg_deals();

create trigger cf50_cl_ins after insert on public.clients referencing new table as newrows for each statement execute function public.cf_trg_clients();
create trigger cf50_cl_upd after update on public.clients referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_clients();
create trigger cf50_cl_del after delete on public.clients referencing old table as oldrows for each statement execute function public.cf_trg_clients();

-- pipelines / phases: only a rename or a Win flag change recalculates (see 55_pipeline_saves_fast.sql)
create trigger cf50_pipe_upd after update on public.pipelines referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_pipes();
create trigger cf50_phase_upd after update on public.pipeline_phases referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_pipes();
create trigger cf50_opt_ins after insert on public.crm_options referencing new table as newrows for each statement execute function public.cf_trg_tenant_wide();
create trigger cf50_opt_upd after update on public.crm_options referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_tenant_wide();
create trigger cf50_opt_del after delete on public.crm_options referencing old table as oldrows for each statement execute function public.cf_trg_tenant_wide();
create trigger cf50_cof_ins after insert on public.company_fields referencing new table as newrows for each statement execute function public.cf_trg_tenant_wide();
create trigger cf50_cof_upd after update on public.company_fields referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_tenant_wide();
create trigger cf50_cof_del after delete on public.company_fields referencing old table as oldrows for each statement execute function public.cf_trg_tenant_wide();

-- ---------------------------------------------------------------------
-- 4. the list: filters / sort of a saved view → SQL (only known fields)
-- ---------------------------------------------------------------------
-- one field of the list as SQL, or null when it isn't a list field
create or replace function public.contacts_fx(p_key text, p_type text, p_ctx jsonb default '{}')
returns text language plpgsql immutable as $$
declare k text := coalesce(p_key, ''); id text; req text[]; parts text[];
begin
  if k = 'name' then return $s$concat_ws(' ', nullif(btrim(c.first_name), ''), nullif(btrim(c.last_name), ''))$s$; end if;
  if k in ('first_name', 'last_name', 'position', 'email', 'linkedin', 'notes', 'postal_code') then return format('c.%I', k); end if;
  if k = 'phone' then return $s$case when coalesce(c.phone, '') <> '' then c.phone || coalesce(' · ext. ' || nullif(c.phone_ext, ''), '') end$s$; end if;
  if k = 'landline' then return $s$case when coalesce(c.landline, '') <> '' then c.landline || coalesce(' · ext. ' || nullif(c.landline_ext, ''), '') end$s$; end if;
  if k in ('language', 'country') then return format('coalesce(c.%I, %L)', k, ''); end if;
  if k in ('city', 'province') then return format('btrim(coalesce(c.%I, %L))', k, ''); end if;
  if k = 'street' then return $s$concat_ws(' ', nullif(btrim(c.street), ''), nullif(btrim(c.addr_number), ''))$s$; end if;
  if k = 'address' then return $s$concat_ws(', ', nullif(concat_ws(' ', nullif(btrim(c.street), ''), nullif(btrim(c.addr_number), '')), ''),
      nullif(concat_ws(' ', nullif(btrim(c.postal_code), ''), nullif(btrim(c.city), ''),
        case when coalesce(btrim(c.province), '') <> '' and public.fx_norm(c.province) <> public.fx_norm(c.city) then '(' || btrim(c.province) || ')' end), ''),
      nullif(btrim(c.country), ''))$s$; end if;
  if k = 'addr_complete' then
    req := array(select jsonb_array_elements_text(coalesce(p_ctx -> 'required', '["street","addr_number","postal_code","city","country"]'::jsonb)));
    parts := array(select format('coalesce(btrim(c.%I), %L) <> %L', x, '', '') from unnest(req) x
                   where x in ('street', 'addr_number', 'postal_code', 'city', 'province', 'country', 'language', 'linkedin'));
    return case when cardinality(parts) = 0 then 'true' else '(' || array_to_string(parts, ' and ') || ')' end;
  end if;
  if k = 'created_at' then return 'c.created_at'; end if;
  if k = 'imported_at' then return 'c.imported_at'; end if;
  if k = 'imported_by' then return $s$coalesce(c.imported_by::text, '')$s$; end if;
  if k = 'companies' then return 'x.company_ids::text[]'; end if;
  if k = 'companies_count' then return 'cardinality(x.company_ids)'; end if;
  if k = 'co_sector' then return 'x.co_sectors'; end if;
  if k = 'co_city' then return 'x.co_cities'; end if;
  if k = 'co_type' then return 'x.types'; end if;
  if k = 'status' then return 'x.status'; end if;
  if k = 'pipelines' then return 'x.pipelines'; end if;
  if k = 'visible_to' then return 'x.assignees::text[]'; end if;
  if k ~ '^co_field_[0-9a-f-]{36}$' then
    id := substr(k, 10);
    if p_type = 'boolean' then return format('coalesce((x.co_custom -> %L) ? %L, false)', id, 'true'); end if;
    return format('public.fx_list(x.co_custom -> %L)', id);
  end if;
  if k ~ '^[0-9a-f-]{36}$' then   -- your own contact field
    if p_type = 'multi' then return format('public.fx_list(c.custom -> %L)', k); end if;
    if p_type = 'number' then return format('public.fx_num(c.custom ->> %L)', k); end if;
    if p_type = 'boolean' then return format('public.fx_bool(c.custom -> %L)', k); end if;
    return format('(c.custom ->> %L)', k);
  end if;
  return null;
end $$;

-- one filter condition → SQL (the same meaning as the app's filters)
create or replace function public.list_cond_sql(e text, p_type text, c jsonb)
returns text language plpgsql immutable as $$
declare op text := c ->> 'op'; t text := public.fx_norm(c ->> 'text'); vals text[]; mn text := nullif(c ->> 'min', ''); mx text := nullif(c ->> 'max', '');
        ty text := coalesce(p_type, 'text'); d text;
begin
  vals := array(select jsonb_array_elements_text(case when jsonb_typeof(c -> 'values') = 'array' then c -> 'values' else '[]'::jsonb end));
  -- unfinished filters are ignored (true)
  if op in ('in', 'nin', 'any', 'all', 'none') and cardinality(vals) = 0 then return null; end if;
  if op = 'between' and mn is null and mx is null then return null; end if;
  if op in ('gt', 'lt', 'eq', 'before', 'after') and mn is null then return null; end if;
  if op in ('contains', 'ncontains', 'is', 'starts') and coalesce(btrim(c ->> 'text'), '') = '' then return null; end if;

  if ty = 'multi' then
    if op = 'has' then return format('cardinality(coalesce(%s, %L::text[])) > 0', e, '{}'); end if;
    if op = 'empty' then return format('cardinality(coalesce(%s, %L::text[])) = 0', e, '{}'); end if;
    if op = 'any' then return format('coalesce(%s, %L::text[]) && %L::text[]', e, '{}', vals); end if;
    if op = 'all' then return format('coalesce(%s, %L::text[]) @> %L::text[]', e, '{}', vals); end if;
    if op = 'none' then return format('not (coalesce(%s, %L::text[]) && %L::text[])', e, '{}', vals); end if;
    return null;
  end if;
  if ty = 'boolean' then
    if op in ('yes', 'has') then return format('coalesce(%s, false)', e); end if;
    if op in ('no', 'empty') then return format('not coalesce(%s, false)', e); end if;
    return null;
  end if;
  if ty = 'number' then
    if op = 'has' then return format('(%s) is not null', e); end if;
    if op = 'empty' then return format('(%s) is null', e); end if;
    if op = 'gt' then return format('(%s) > %s', e, public.fx_num(mn)); end if;
    if op = 'lt' then return format('(%s) < %s', e, public.fx_num(mn)); end if;
    if op = 'eq' then return format('(%s) = %s', e, public.fx_num(mn)); end if;
    if op = 'between' then
      return format('(%s) is not null', e)
        || coalesce(format(' and (%s) >= %s', e, public.fx_num(mn)), '') || coalesce(format(' and (%s) <= %s', e, public.fx_num(mx)), '');
    end if;
    return null;
  end if;
  if ty = 'date' then
    d := format('left(nullif((%s)::text, %L), 10)', e, '');
    if op = 'has' then return format('%s is not null', d); end if;
    if op = 'empty' then return format('%s is null', d); end if;
    if op = 'last7' then return format('%s between to_char(current_date - 7, %L) and to_char(current_date, %L)', d, 'YYYY-MM-DD', 'YYYY-MM-DD'); end if;
    if op = 'last30' then return format('%s between to_char(current_date - 30, %L) and to_char(current_date, %L)', d, 'YYYY-MM-DD', 'YYYY-MM-DD'); end if;
    if op = 'last90' then return format('%s between to_char(current_date - 90, %L) and to_char(current_date, %L)', d, 'YYYY-MM-DD', 'YYYY-MM-DD'); end if;
    if op = 'this_month' then return format('%s between to_char(date_trunc(%L, current_date), %L) and to_char(date_trunc(%L, current_date) + interval %L - interval %L, %L)', d, 'month', 'YYYY-MM-DD', 'month', '1 month', '1 day', 'YYYY-MM-DD'); end if;
    if op = 'this_year' then return format('%s between to_char(current_date, %L) || %L and to_char(current_date, %L) || %L', d, 'YYYY', '-01-01', 'YYYY', '-12-31'); end if;
    if op = 'next30' then return format('%s between to_char(current_date, %L) and to_char(current_date + 30, %L)', d, 'YYYY-MM-DD', 'YYYY-MM-DD'); end if;
    if op = 'before' then return format('%s < %L', d, mn); end if;
    if op = 'after' then return format('%s > %L', d, mn); end if;
    if op = 'between' then
      return format('%s is not null', d) || coalesce(format(' and %s >= %L', d, mn), '') || coalesce(format(' and %s <= %L', d, mx), '');
    end if;
    return null;
  end if;
  if ty = 'select' then
    if op = 'has' then return format('coalesce((%s)::text, %L) <> %L', e, '', ''); end if;
    if op = 'empty' then return format('coalesce((%s)::text, %L) = %L', e, '', ''); end if;
    if op = 'in' then return format('coalesce((%s)::text, %L) = any(%L::text[])', e, '', vals); end if;
    if op = 'nin' then return format('not (coalesce((%s)::text, %L) = any(%L::text[]))', e, '', vals); end if;
    return null;
  end if;
  -- text
  if op = 'has' then return format('coalesce(btrim((%s)::text), %L) <> %L', e, '', ''); end if;
  if op = 'empty' then return format('coalesce(btrim((%s)::text), %L) = %L', e, '', ''); end if;
  if op = 'contains' then return format('strpos(public.fx_norm((%s)::text), %L) > 0', e, btrim(t)); end if;
  if op = 'ncontains' then return format('strpos(public.fx_norm((%s)::text), %L) = 0', e, btrim(t)); end if;
  if op = 'is' then return format('btrim(public.fx_norm((%s)::text)) = %L', e, btrim(t)); end if;
  if op = 'starts' then return format('left(btrim(public.fx_norm((%s)::text)), %s) = %L', e, length(btrim(t)), btrim(t)); end if;
  return null;
end $$;

-- the WHERE + ORDER BY of a view
create or replace function public.contacts_view_sql(p_view jsonb, p_search text, p_ctx jsonb, out w text, out o text)
language plpgsql immutable as $$
declare c jsonb; e text; s text; parts text[] := '{}'; ords text[] := '{}'; q text := btrim(public.fx_norm(p_search)); ty text; dir text;
begin
  for c in select * from jsonb_array_elements(case when jsonb_typeof(p_view -> 'conds') = 'array' then p_view -> 'conds' else '[]'::jsonb end) loop
    ty := coalesce(c ->> 'type', 'text');
    e := public.contacts_fx(c ->> 'field', ty, p_ctx);
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
    elsif c ->> 'key' = 'co_type' then e := 'x.type_sort';
    elsif c ->> 'key' = 'companies' then e := $s$nullif(public.fx_norm(array_to_string(x.company_names, ', ')), '')$s$;
    else
      e := public.contacts_fx(c ->> 'key', ty, p_ctx);
      if e is null then continue; end if;
      if ty = 'multi' then e := format('nullif(public.fx_norm(array_to_string(%s, %L)), %L)', e, ', ', '');
      elsif ty in ('number') then e := format('(%s)', e);
      elsif ty = 'boolean' then e := format('(case when coalesce(%s, false) then 1 else 0 end)', e);
      elsif ty = 'date' then e := format('(%s)', e);
      else e := format('nullif(public.fx_norm((%s)::text), %L)', e, '');
      end if;
    end if;
    ords := ords || format('%s %s nulls last', e, dir);
  end loop;
  o := array_to_string(ords || array['x.name_sort asc', 'c.id asc'], ', ');
end $$;

-- one page of contacts (p_mode 'page'), every matching id ('ids'), or just the count ('count')
create or replace function public.contacts_list(
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
  select * into v from public.contacts_view_sql(p_view, p_search, p_ctx);
  base := format('from public.contacts c join public.contact_facts x on x.contact_id = c.id
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
    select coalesce(jsonb_agg(public.contact_row_json(z.id) order by z.n), '[]')
    from (select c.id, row_number() over () as n from (select c.id %s order by %s offset %s limit %s) c) z$q$,
    base, v.o, greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 100), 1), 500)) into out;
  return jsonb_build_object('total', total, 'rows', out);
end $$;
grant execute on function public.contacts_list(jsonb, text, int, int, text, jsonb) to authenticated;

-- one contact in list format: its row + companies, types, status, pipelines, who sees it
create or replace function public.contact_row_json(p_id uuid)
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select (to_jsonb(c) - 'tenant_id') || jsonb_build_object(
    'companyIds', to_jsonb(x.company_ids),
    '__coNames', coalesce((select jsonb_object_agg(i::text, n) from unnest(x.company_ids, x.company_names) u(i, n)), '{}'::jsonb),
    '__types', to_jsonb(x.types),
    '__from', x.types_from,
    '__status', to_jsonb(x.status),
    '__pipes', to_jsonb(x.pipelines),
    '__assignees', to_jsonb(x.assignees))
  from public.contacts c join public.contact_facts x on x.contact_id = c.id
  where c.id = p_id
$$;
grant execute on function public.contact_row_json(uuid) to authenticated;

-- given contacts (selection, after a save), in list format, in the order asked
create or replace function public.contacts_rows(p_ids uuid[])
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(public.contact_row_json(k.id) order by k.ord) filter (where exists (select 1 from public.contacts c where c.id = k.id)), '[]'::jsonb)
  from unnest(p_ids) with ordinality k(id, ord)
$$;
grant execute on function public.contacts_rows(uuid[]) to authenticated;

-- the values each filter offers (so the page never needs the whole list for them)
create or replace function public.contacts_facets()
returns jsonb language plpgsql stable security invoker set search_path = public, extensions as $$
declare tenant uuid := public.current_tenant(); out jsonb := '{}'::jsonb; r record;
begin
  if tenant is null then return out; end if;
  out := jsonb_build_object(
    'language', (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(language) v from public.contacts where tenant_id = tenant and coalesce(btrim(language), '') <> '' limit 2000) z),
    'country',  (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(country) v from public.contacts where tenant_id = tenant and coalesce(btrim(country), '') <> '' limit 2000) z),
    'city',     (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(city) v from public.contacts where tenant_id = tenant and coalesce(btrim(city), '') <> '' limit 5000) z),
    'province', (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(province) v from public.contacts where tenant_id = tenant and coalesce(btrim(province), '') <> '' limit 5000) z),
    'co_sector',(select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(sector) v from public.companies where tenant_id = tenant and coalesce(btrim(sector), '') <> '' limit 2000) z),
    'co_city',  (select coalesce(jsonb_agg(v order by v), '[]') from (select distinct btrim(city) v from public.companies where tenant_id = tenant and coalesce(btrim(city), '') <> '' limit 5000) z),
    'pipelines',(select coalesce(jsonb_agg(v order by v), '[]') from (select distinct name v from public.pipelines where coalesce(name, '') <> '') z),
    'co_types', (select coalesce(jsonb_agg(distinct t), '[]') from public.companies co,
                   jsonb_array_elements_text(case when jsonb_typeof(to_jsonb(co) -> 'relationship') = 'array' then to_jsonb(co) -> 'relationship' else '[]'::jsonb end) t
                 where co.tenant_id = tenant),
    -- companies that have people (id + name), for the "Company" filter and "Add to company"
    'companies',(select coalesce(jsonb_agg(jsonb_build_object('value', id, 'label', name) order by name), '[]') from (
                   select co.id, co.name from public.companies co where co.tenant_id = tenant order by co.name limit 20000) z)
  );
  -- your own multi-choice contact fields: every value in use
  out := out || jsonb_build_object('custom', coalesce((
    select jsonb_object_agg(f.id::text, (
      select coalesce(jsonb_agg(distinct v), '[]') from (
        select unnest(public.fx_list(c.custom -> f.id::text)) v from public.contacts c
        where c.tenant_id = tenant and c.custom ? f.id::text limit 20000) z))
    from public.contact_fields f where f.type = 'multiselect'), '{}'::jsonb));
  -- company choice fields: every value in use
  out := out || jsonb_build_object('co_fields', coalesce((
    select jsonb_object_agg(f.id::text, (
      select coalesce(jsonb_agg(distinct v), '[]') from (
        select unnest(case when f.type = 'multiselect' then public.fx_list(co.custom -> f.id::text)
                           else array[co.custom ->> f.id::text] end) v
        from public.companies co where co.tenant_id = tenant and co.custom ? f.id::text limit 20000) z where coalesce(v, '') <> ''))
    from public.company_fields f where f.type in ('select', 'multiselect')), '{}'::jsonb));
  return out;
end $$;
grant execute on function public.contacts_facets() to authenticated;

-- ---------------------------------------------------------------------
-- 5. fill contact_facts for every contact (per tenant, in chunks)
-- ---------------------------------------------------------------------
do $$
declare ts uuid[];
begin
  select array_agg(distinct tenant_id) into ts from public.contacts where tenant_id is not null;
  perform public.cf_refresh_tenants(ts);
  delete from public.contact_facts f where not exists (select 1 from public.contacts c where c.id = f.contact_id);
end $$;
analyze public.contact_facts;

-- result
select count(*) as contacts_ready,
       count(*) filter (where 'client' = any(types)) as clients,
       count(*) filter (where 'sales' = any(types)) as in_sales,
       count(*) filter (where cardinality(company_ids) = 0) as without_company
from public.contact_facts;
