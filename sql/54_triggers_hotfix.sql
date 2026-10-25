-- =====================================================================
-- 54_triggers_hotfix.sql — URGENT fix for 50 / 51
-- =====================================================================
-- Some of the automatic updates added by 50 and 51 read "the new rows" and
-- "the old rows" in the same statement. On an INSERT there are no old rows
-- and on a DELETE no new rows, so Postgres stopped with
--     relation "newrows" does not exist
-- when you deleted a client, created a company or a deal, linked a contact
-- to a company, added a company type… This replaces those functions with
-- versions that only read what exists for each kind of change.
-- Nothing else changes. Safe to run more than once.
-- =====================================================================
set search_path = public, extensions;

-- ---------- contacts side (50) ----------
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

-- the contact ids written on a client (ids, or {sourceId} / {contact_id})
create or replace function public.cf_client_people(v jsonb) returns uuid[]
language sql immutable as $$
  select coalesce(array_agg(z.cid::uuid), '{}') from (
    select coalesce(e ->> 'sourceId', e ->> 'contact_id', case when jsonb_typeof(e) = 'string' then e #>> '{}' end) as cid
    from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end) e) z
  where z.cid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- tenant of a row (or of its pipeline, for phases)
create or replace function public.cf_row_tenant(j jsonb) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((j ->> 'tenant_id')::uuid,
                  (select (to_jsonb(p) ->> 'tenant_id')::uuid from public.pipelines p where p.id = (j ->> 'pipeline_id')::uuid))
$$;

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

-- ---------- companies side (51) ----------
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

do $$ begin
  if to_regprocedure('public.cof_refresh_tenants(uuid[])') is not null then
    execute $f$
      create or replace function public.cof_trg_tenant_wide() returns trigger
      language plpgsql security definer set search_path = public, extensions as $b$
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
      end $b$;
    $f$;
  end if;
end $$;

select 'Fixed: creating, linking and deleting work again' as done;
