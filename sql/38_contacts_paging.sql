-- =====================================================================
-- 38_contacts_paging.sql — the contacts list in pages, from the database
-- =====================================================================
-- With tens of thousands of contacts the Contacts page waited for the whole
-- list before showing anything. These functions let it paint the first page
-- at once (and search before everything has arrived), and count each
-- company's contacts without downloading every link.
--
--   contacts_page(search, filters, sort, dir, offset, limit)
--       one page of the list: the contact, its companies (ids + names),
--       its types (CRM, client, in sales, the companies' own types) and the
--       total number of matches.
--   contact_ids_by_filter(search)   every matching contact id (select-all, export)
--   company_contact_counts()        contacts per company
--
-- They run as the signed-in user (SECURITY INVOKER): row security decides
-- what each person sees, exactly as with the tables. Nothing is changed in
-- your data. Safe to run more than once.
-- Undo: drop function public.contacts_page(text, jsonb, text, text, int, int),
--       public.contact_ids_by_filter(text), public.company_contact_counts();
-- =====================================================================

-- a plain index for the list order (first name, last name)
create index if not exists ix38_contacts_name_order on public.contacts (first_name, last_name, id);

-- one trigram index over everything the search box looks at (name, e-mail, position, phone, city):
-- "contains" searches on 50,000 contacts use it instead of reading the whole table
do $$
declare ops text;
begin
  select n.nspname || '.gin_trgm_ops' into ops
  from pg_opclass oc join pg_namespace n on n.oid = oc.opcnamespace
  where oc.opcname = 'gin_trgm_ops' limit 1;
  if ops is null then
    begin create extension if not exists pg_trgm with schema extensions;
    exception when others then create extension if not exists pg_trgm; end;
    select n.nspname || '.gin_trgm_ops' into ops
    from pg_opclass oc join pg_namespace n on n.oid = oc.opcnamespace
    where oc.opcname = 'gin_trgm_ops' limit 1;
  end if;
  execute format($i$create index if not exists ix38_contacts_search_trgm on public.contacts using gin (
    (coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email, '') || ' ' ||
     coalesce(position, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(city, '')) %s)$i$, ops);
end $$;

-- (an earlier draft had a separate matching function; it is not used)
drop function if exists public.contacts_match(public.contacts, text);

-- ---------------------------------------------------------------------
-- one page of contacts
-- ---------------------------------------------------------------------
drop function if exists public.contacts_page(text, jsonb, text, text, int, int);
create function public.contacts_page(
  p_search  text  default null,
  p_filters jsonb default '{}'::jsonb,   -- reserved: the app filters the full list itself once it has loaded
  p_sort    text  default 'name',        -- 'name' | 'created_at'
  p_dir     text  default 'asc',         -- 'asc' | 'desc'
  p_offset  int   default 0,
  p_limit   int   default 80
)
returns table (contact jsonb, company_ids uuid[], company_names text[], types text[], total bigint)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q     text   := nullif(btrim(coalesce(p_search, '')), '');
  pat   text   := '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  off   int    := greatest(coalesce(p_offset, 0), 0);
  lim   int    := least(greatest(coalesce(p_limit, 80), 1), 500);
  n     bigint;
  ids   uuid[];
begin
  -- 1. the ids of the page (and how many match), using the name / trigram indexes
  if q is null then
    select count(*) into n from public.contacts;
    if p_sort = 'created_at' and p_dir = 'desc' then
      select array_agg(x.id) into ids from (select c.id from public.contacts c order by c.created_at desc nulls last, c.id desc offset off limit lim) x;
    elsif p_sort = 'created_at' then
      select array_agg(x.id) into ids from (select c.id from public.contacts c order by c.created_at asc nulls last, c.id offset off limit lim) x;
    elsif p_dir = 'desc' then
      select array_agg(x.id) into ids from (select c.id from public.contacts c order by c.first_name desc nulls last, c.last_name desc nulls last, c.id desc offset off limit lim) x;
    else
      select array_agg(x.id) into ids from (select c.id from public.contacts c order by c.first_name nulls last, c.last_name nulls last, c.id offset off limit lim) x;
    end if;
  else
    with hits as (
      select c.id, c.first_name, c.last_name, c.created_at from public.contacts c
      where (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '') || ' ' || coalesce(c.email, '') || ' ' ||
             coalesce(c.position, '') || ' ' || coalesce(c.phone, '') || ' ' || coalesce(c.city, '')) ilike pat
      union
      select c.id, c.first_name, c.last_name, c.created_at
      from public.companies co
      join public.company_contacts cc on cc.company_id = co.id
      join public.contacts c on c.id = cc.contact_id
      where co.name ilike pat
    ),
    ranked as (
      select h.id, row_number() over (order by
        case when p_sort = 'created_at' and p_dir = 'desc' then h.created_at end desc nulls last,
        case when p_sort = 'created_at' and p_dir <> 'desc' then h.created_at end asc nulls last,
        case when p_sort <> 'created_at' and p_dir = 'desc' then h.first_name end desc nulls last,
        case when p_sort <> 'created_at' and p_dir = 'desc' then h.last_name end desc nulls last,
        h.first_name nulls last, h.last_name nulls last, h.id) as rn
      from hits h
    )
    select (select count(*) from hits),
           (select array_agg(r.id order by r.rn) from ranked r where r.rn > off and r.rn <= off + lim)
      into n, ids;
  end if;
  if ids is null then return; end if;

  -- 2. the page itself, with each contact's companies and types
  return query
  with cut as (
    select c.*, k.ord from unnest(ids) with ordinality k(id, ord) join public.contacts c on c.id = k.id
  ),
  links as (
    select cc.contact_id, co.id as company_id, co.name,
           case when jsonb_typeof(to_jsonb(co) -> 'relationship') = 'array' then to_jsonb(co) -> 'relationship' else '[]'::jsonb end as rel
    from public.company_contacts cc
    join public.companies co on co.id = cc.company_id
    where cc.contact_id = any(ids)
  ),
  won_phase as (
    select pp.id from public.pipeline_phases pp where pp.sales_outcome = 'win'
  ),
  open_deal as (   -- deals still in play (not won) of these contacts' companies, or with them on it
    select t.id, t.company_id
    from public.trackings t
    where coalesce(t.status, '') <> 'won'
      and coalesce((to_jsonb(t) ->> 'current_phase_id')::uuid, '00000000-0000-0000-0000-000000000000'::uuid) not in (select wp.id from won_phase wp)
      and (t.company_id in (select l.company_id from links l)
           or t.id in (select tc.tracking_id from public.tracking_contacts tc where tc.contact_id = any(ids)))
  )
  select
    to_jsonb(cut) - 'ord' - 'tenant_id',
    coalesce((select array_agg(l.company_id order by l.name) from links l where l.contact_id = cut.id), '{}'::uuid[]),
    coalesce((select array_agg(l.name order by l.name) from links l where l.contact_id = cut.id), '{}'::text[]),
    array_remove(
      array['crm',
        case when exists (select 1 from public.clients cl join links l on l.company_id = cl.company_id where l.contact_id = cut.id) then 'client' end,
        case when exists (select 1 from open_deal d join links l on l.company_id = d.company_id where l.contact_id = cut.id)
               or exists (select 1 from public.tracking_contacts tc join open_deal d on d.id = tc.tracking_id where tc.contact_id = cut.id) then 'sales' end
      ]::text[]
      || coalesce((select array_agg(distinct t.tag order by t.tag) from links l cross join lateral jsonb_array_elements_text(l.rel) t(tag)
                   where l.contact_id = cut.id and lower(t.tag) not in ('crm', 'client', 'sales')), '{}'::text[]),
      null::text),
    n
  from cut
  order by cut.ord;
end;
$$;

-- ---------------------------------------------------------------------
-- every matching id (for "select all" and export)
-- ---------------------------------------------------------------------
create or replace function public.contact_ids_by_filter(p_search text default null)
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  with pat as (select '%' || replace(replace(replace(btrim(coalesce(p_search, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as p)
  select c.id from public.contacts c, pat
  where btrim(coalesce(p_search, '')) = ''
     or (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '') || ' ' || coalesce(c.email, '') || ' ' ||
         coalesce(c.position, '') || ' ' || coalesce(c.phone, '') || ' ' || coalesce(c.city, '')) ilike pat.p
     or c.id in (select cc.contact_id from public.company_contacts cc join public.companies co on co.id = cc.company_id, pat p2 where co.name ilike p2.p)
$$;

-- ---------------------------------------------------------------------
-- contacts per company
-- ---------------------------------------------------------------------
create or replace function public.company_contact_counts()
returns table (company_id uuid, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select cc.company_id, count(distinct cc.contact_id) from public.company_contacts cc
  where cc.company_id is not null
  group by cc.company_id
$$;

grant execute on function public.contacts_page(text, jsonb, text, text, int, int) to authenticated;
grant execute on function public.contact_ids_by_filter(text) to authenticated;
grant execute on function public.company_contact_counts() to authenticated;

analyze public.contacts;
analyze public.company_contacts;
notify pgrst, 'reload schema';

-- what is installed
select p.proname as installed_function
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('contacts_page', 'contact_ids_by_filter', 'company_contact_counts')
order by 1;
