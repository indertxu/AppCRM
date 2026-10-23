-- =====================================================================
-- 36_performance.sql — faster Deals, Contacts, Companies (and everything else)
-- =====================================================================
-- Safe to run more than once. It never deletes or changes data, never drops a
-- column and never rewrites a table. What it does:
--
--   1. pg_trgm (fast "contains" search on names / e-mails).
--   2. Indexes:
--      a. every foreign key without an index gets one (joins and "by deal",
--         "by company"… reads stop scanning whole tables);
--      b. every table with tenant_id gets (tenant_id, created_at) — or just
--         (tenant_id) — so each tenant's rows are found without a full scan;
--      c. the filters / sorts the app uses most (deals by status, pipeline,
--         phase; calendar by person and date; links contact↔company; …);
--      d. trigram indexes for searching companies, contacts and deals.
--      Every index it creates is listed in perf_indexes_bk36 (for the undo).
--   3. Row-level security: the rules like  tenant_id = current_tenant()  ran
--      current_tenant() (a lookup of your profile) ONCE PER ROW. With 15,000
--      deals that is 15,000 lookups per list. They are rewritten to
--      tenant_id = (select current_tenant()), which Postgres runs ONCE per
--      query. Same rule, same result — only faster. Also auth.uid(),
--      auth.jwt(), auth.role() and other no-argument helpers used in the rules.
--      The exact old rules are kept in perf_policies_bk36 (for the undo).
--   4. ANALYZE so the planner knows the new indexes and table sizes.
--
-- Run the whole file in Supabase › SQL editor. The last result is a summary.
-- Undo: 36_performance_undo.sql
-- =====================================================================

do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      create extension pg_trgm with schema extensions;
    else
      create extension pg_trgm;
    end if;
  end if;
end $$;

-- ---------- bookkeeping (what this file created / replaced) ----------
create table if not exists public.perf_indexes_bk36 (index_name text primary key, table_name text, created_at timestamptz default now());
alter table public.perf_indexes_bk36 enable row level security;
create table if not exists public.perf_policies_bk36 (
  table_name text, policy_name text, permissive text, cmd text, roles text[],
  old_qual text, old_with_check text, new_qual text, new_with_check text,
  replaced_at timestamptz default now(), primary key (table_name, policy_name));
alter table public.perf_policies_bk36 enable row level security;

-- ---------- helpers (temporary, gone when the session ends) ----------
-- does public.<t> exist and have every column in cols?
create or replace function pg_temp.has_cols(t text, cols text[]) returns boolean language sql stable as $$
  select to_regclass('public.' || quote_ident(t)) is not null
     and (select count(*) from information_schema.columns c
          where c.table_schema = 'public' and c.table_name = t and c.column_name = any(cols)) = cardinality(cols)
$$;

-- is there already an index on t whose leading columns are exactly cols (in order)?
create or replace function pg_temp.has_index_on(t text, cols text[]) returns boolean language sql stable as $$
  select exists (
    select 1
    from pg_index i
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace and n.nspname = 'public'
    where tc.relname = t
      and i.indpred is null
      and (select array_agg(a.attname::text order by k.ord)
           from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = tc.oid and a.attnum = k.attnum
           where k.ord <= cardinality(cols)) = cols)
$$;

-- a short, unique, valid index name
create or replace function pg_temp.ix_name(t text, tag text) returns text language sql immutable as $$
  select left('ix36_' || t || '_' || tag, 50) || '_' || substr(md5(t || ':' || tag), 1, 8)
$$;

-- create a plain btree index on columns (skips if table/columns missing or an
-- equivalent index already exists)
create or replace function pg_temp.ix(t text, cols text[], tag text default null) returns text language plpgsql as $$
declare nm text;
begin
  if not pg_temp.has_cols(t, cols) then return null; end if;
  if pg_temp.has_index_on(t, cols) then return null; end if;
  nm := pg_temp.ix_name(t, coalesce(tag, array_to_string(cols, '_')));
  begin
    execute format('create index if not exists %I on public.%I (%s)', nm, t,
                   (select string_agg(quote_ident(c), ', ') from unnest(cols) c));
    insert into public.perf_indexes_bk36 (index_name, table_name) values (nm, t) on conflict do nothing;
  exception when others then
    raise notice 'index % skipped: %', nm, sqlerrm;
    return null;
  end;
  return nm;
end $$;

-- create an expression / special index (skips if table/columns missing or name exists)
create or replace function pg_temp.ixx(t text, need text[], tag text, body text) returns text language plpgsql as $$
declare nm text;
begin
  if not pg_temp.has_cols(t, need) then return null; end if;
  nm := pg_temp.ix_name(t, tag);
  if to_regclass('public.' || quote_ident(nm)) is not null then return null; end if;
  -- trigram operator class lives wherever pg_trgm was installed (extensions or public)
  body := replace(body, 'TRGM_OPS', coalesce((
    select quote_ident(n.nspname) || '.gin_trgm_ops' from pg_opclass oc join pg_namespace n on n.oid = oc.opcnamespace
    where oc.opcname = 'gin_trgm_ops' limit 1), 'gin_trgm_ops'));
  begin
    execute format('create index if not exists %I on public.%I %s', nm, t, body);
    insert into public.perf_indexes_bk36 (index_name, table_name) values (nm, t) on conflict do nothing;
  exception when others then
    raise notice 'index % skipped: %', nm, sqlerrm;
    return null;
  end;
  return nm;
end $$;

-- =====================================================================
-- 2a. an index for every foreign key that has none
-- =====================================================================
do $$
declare fk record; cols text[];
begin
  for fk in
    select cl.relname::text as t, con.conkey, con.conrelid
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    where con.contype = 'f'
      and cl.relname not like '%\_bk%' and cl.relname not like '%backup%'
  loop
    select array_agg(a.attname::text order by k.ord) into cols
    from unnest(fk.conkey) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = fk.conrelid and a.attnum = k.attnum;
    perform pg_temp.ix(fk.t, cols);
  end loop;
end $$;

-- =====================================================================
-- 2b. every tenant table: (tenant_id, created_at) or (tenant_id)
-- =====================================================================
do $$
declare r record;
begin
  for r in
    select c.table_name::text as t
    from information_schema.columns c
    join information_schema.tables it on it.table_schema = 'public' and it.table_name = c.table_name and it.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'tenant_id'
      and c.table_name not like '%\_bk%' and c.table_name not like '%backup%'
  loop
    if pg_temp.has_index_on(r.t, array['tenant_id']) then continue; end if;
    if pg_temp.has_cols(r.t, array['created_at']) then
      perform pg_temp.ix(r.t, array['tenant_id', 'created_at'], 'tenant_created');
    else
      perform pg_temp.ix(r.t, array['tenant_id'], 'tenant');
    end if;
  end loop;
end $$;

-- =====================================================================
-- 2c. the filters and sorts the app uses most
-- =====================================================================
do $$
begin
  -- deals
  perform pg_temp.ix('trackings', array['tenant_id', 'status']);
  perform pg_temp.ix('trackings', array['pipeline_id', 'phase_id']);
  perform pg_temp.ix('trackings', array['company_id']);
  perform pg_temp.ix('trackings', array['handover_to']);
  perform pg_temp.ix('trackings', array['created_at']);
  perform pg_temp.ix('tracking_contacts', array['tracking_id', 'contact_id']);
  perform pg_temp.ix('tracking_contacts', array['contact_id']);
  perform pg_temp.ix('tracking_employees', array['tracking_id', 'profile_id']);
  perform pg_temp.ix('tracking_employees', array['profile_id']);
  perform pg_temp.ix('tracking_phase_events', array['tracking_id', 'phase_id']);
  perform pg_temp.ix('tracking_products', array['tracking_id', 'created_at']);
  perform pg_temp.ix('tracking_products', array['version_group']);
  perform pg_temp.ix('tracking_potential_services', array['tracking_id']);
  perform pg_temp.ix('tracking_tasks', array['tracking_id', 'created_at']);
  perform pg_temp.ix('tracking_tasks', array['assignee_id']);
  perform pg_temp.ix('tracking_tasks', array['created_by']);
  perform pg_temp.ix('tracking_task_updates', array['task_id']);
  perform pg_temp.ix('tracking_notes', array['tracking_id', 'created_at']);
  perform pg_temp.ix('tracking_notes', array['phase_id']);
  perform pg_temp.ix('tracking_files', array['tracking_id', 'created_at']);
  perform pg_temp.ix('tracking_assignees', array['tracking_id']);
  perform pg_temp.ix('deal_proposals', array['tracking_id', 'created_at']);
  perform pg_temp.ix('handoffs', array['tracking_id']);
  -- contacts / companies
  perform pg_temp.ix('company_contacts', array['company_id', 'contact_id']);
  perform pg_temp.ix('company_contacts', array['contact_id']);
  perform pg_temp.ix('company_assignees', array['company_id', 'profile_id']);
  perform pg_temp.ix('contact_assignees', array['contact_id', 'profile_id']);
  perform pg_temp.ix('companies', array['name', 'id']);
  perform pg_temp.ix('contacts', array['first_name', 'id']);
  perform pg_temp.ix('meeting_contacts', array['contact_id']);
  perform pg_temp.ix('meeting_contacts', array['entry_id']);
  -- options and settings
  perform pg_temp.ix('crm_options', array['tenant_id', 'kind']);
  perform pg_temp.ix('crm_options', array['kind']);
  -- clients / projects / billing
  perform pg_temp.ix('clients', array['company_id']);
  perform pg_temp.ix('client_products', array['client_id']);
  perform pg_temp.ix('client_products', array['tracking_id']);
  perform pg_temp.ix('client_products', array['product_id']);
  perform pg_temp.ix('client_files', array['client_id']);
  perform pg_temp.ix('client_folders', array['client_id']);
  perform pg_temp.ix('projects', array['client_id']);
  perform pg_temp.ix('projects', array['service_id']);
  perform pg_temp.ix('invoices', array['project_id']);
  perform pg_temp.ix('invoices', array['client_id', 'status']);
  perform pg_temp.ix('invoices', array['period']);
  -- calendar
  perform pg_temp.ix('calendar_entries', array['user_id', 'entry_date']);
  perform pg_temp.ix('calendar_entries', array['entry_date']);
  perform pg_temp.ix('calendar_entries', array['tracking_id']);
  perform pg_temp.ix('calendar_entries', array['client_id', 'entry_date']);
  perform pg_temp.ix('calendar_entries', array['project_id', 'entry_date']);
  perform pg_temp.ix('entry_invites', array['entry_id']);
  perform pg_temp.ix('entry_invites', array['user_id']);
  perform pg_temp.ix('entry_actuals', array['entry_id']);
  -- people
  perform pg_temp.ix('profiles', array['tenant_id']);
  perform pg_temp.ix('profiles', array['client_id']);
end $$;

-- =====================================================================
-- 2d. "contains" search (ilike '%text%') on names and e-mails
-- =====================================================================
do $$
begin
  perform pg_temp.ixx('companies', array['name'], 'name_trgm', 'using gin (name TRGM_OPS)');
  perform pg_temp.ixx('contacts', array['first_name'], 'first_trgm', 'using gin (first_name TRGM_OPS)');
  perform pg_temp.ixx('contacts', array['last_name'], 'last_trgm', 'using gin (last_name TRGM_OPS)');
  perform pg_temp.ixx('contacts', array['email'], 'email_trgm', 'using gin (email TRGM_OPS)');
  perform pg_temp.ixx('contacts', array['linkedin'], 'linkedin_trgm', 'using gin (linkedin TRGM_OPS)');
  perform pg_temp.ixx('contacts', array['email'], 'email_lower', '(lower(email))');
  perform pg_temp.ixx('companies', array['name'], 'name_lower', '(lower(name))');
  perform pg_temp.ixx('trackings', array['name'], 'name_trgm', 'using gin (name TRGM_OPS)');
  perform pg_temp.ixx('clients', array['name'], 'name_trgm', 'using gin (name TRGM_OPS)');
end $$;

-- =====================================================================
-- 3. row-level security: helpers run once per query, not once per row
-- =====================================================================
-- Wraps calls of argument-less helper functions in a sub-select:
--   current_tenant()  →  (SELECT current_tenant())
-- Only these functions are wrapped: auth.uid(), auth.jwt(), auth.role(),
-- current_tenant(), and any other argument-less, non-set function of the
-- public schema used by a rule. A function that takes arguments (for example a
-- rule that checks one row's owner) is left as it is.
do $$
declare
  p record; fn record;
  pat text;
  names text[] := array['auth\.uid', 'auth\.jwt', 'auth\.role', '(?:public\.)?current_tenant'];
  nq text; nw text; n int := 0; kept int := 0;
begin
  -- other argument-less helpers from public that appear in a rule
  for fn in
    select distinct pr.proname::text as name
    from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace and ns.nspname = 'public'
    where pr.pronargs = 0 and not pr.proretset and pr.prorettype <> 'trigger'::regtype
      and pr.proname <> 'current_tenant'
      and exists (select 1 from pg_policies pp where pp.schemaname = 'public'
                  and (coalesce(pp.qual, '') ~ ('\m' || pr.proname || '\(\)') or coalesce(pp.with_check, '') ~ ('\m' || pr.proname || '\(\)')))
  loop
    names := names || ('(?:public\.)?' || fn.name);
  end loop;
  pat := '(?<!SELECT )\m(' || array_to_string(names, '|') || ')\(\)';

  for p in
    select * from pg_policies
    where schemaname = 'public'
      and tablename not like '%\_bk%'
      and (coalesce(qual, '') ~ pat or coalesce(with_check, '') ~ pat)
  loop
    nq := case when p.qual is null then null else regexp_replace(p.qual, pat, '(SELECT \1())', 'g') end;
    nw := case when p.with_check is null then null else regexp_replace(p.with_check, pat, '(SELECT \1())', 'g') end;
    if nq is not distinct from p.qual and nw is not distinct from p.with_check then continue; end if;
    begin
      insert into public.perf_policies_bk36 (table_name, policy_name, permissive, cmd, roles, old_qual, old_with_check, new_qual, new_with_check)
      values (p.tablename, p.policyname, p.permissive, p.cmd, p.roles::text[], p.qual, p.with_check, nq, nw)
      on conflict (table_name, policy_name) do update
        set new_qual = excluded.new_qual, new_with_check = excluded.new_with_check, replaced_at = now();
      -- drop + create in one sub-transaction: if the new rule fails, the old one stays
      execute format('drop policy %I on public.%I', p.policyname, p.tablename);
      execute format('create policy %I on public.%I as %s for %s to %s %s %s',
        p.policyname, p.tablename, p.permissive, p.cmd,
        (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(p.roles::text[]) r),
        case when nq is not null then 'using (' || nq || ')' else '' end,
        case when nw is not null then 'with check (' || nw || ')' else '' end);
      n := n + 1;
    exception when others then
      kept := kept + 1;
      raise notice 'rule % on % kept as it was: %', p.policyname, p.tablename, sqlerrm;
    end;
  end loop;
  raise notice 'Rules made faster: %, kept as they were: %', n, kept;
end $$;

-- =====================================================================
-- 4. statistics
-- =====================================================================
analyze;

-- =====================================================================
-- summary
-- =====================================================================
select 'indexes created by 36' as what, count(*)::text as how_many from public.perf_indexes_bk36
union all
select 'rules made faster (RLS)', count(*)::text from public.perf_policies_bk36
union all
select 'rules still running a helper per row', count(*)::text
from pg_policies p
where p.schemaname = 'public'
  and (coalesce(p.qual, '') ~ '(?<!SELECT )\m(auth\.uid|auth\.jwt|current_tenant)\(\)'
    or coalesce(p.with_check, '') ~ '(?<!SELECT )\m(auth\.uid|auth\.jwt|current_tenant)\(\)');
