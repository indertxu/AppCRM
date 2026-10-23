-- =====================================================================
-- 37_sales_boot_fast.sql — the Deals page opens with ONE call, sales_boot().
-- This makes that call several times faster and its answer much smaller.
-- =====================================================================
-- What changes (same keys as before, so the page reads it the same way):
--   * Built once at the end instead of re-copying the growing answer after every
--     part (the old version copied ~45 MB around ~25 times with 15k deals).
--   * Rows are written straight to JSON text (row_to_json / json_agg), the fastest
--     path in Postgres. The function now returns json instead of jsonb.
--   * Only this workspace's rows are read (explicit tenant filter on top of the
--     row security, so the indexes from 36 are used directly). Super admins keep
--     exactly what row security lets them see.
--   * Left out because the Deals list never uses them (they load when needed):
--       trackings.contract_terms  (read when a contract opens)
--       tenant_id on every row    (each screen that needs it asks for it)
--   * Phase history comes grouped per deal (one entry per deal instead of one
--     per phase entered). The app reads both shapes.
--   * A missing table or column is skipped, as before.
--
-- Safe: it only replaces this one function. Undo: 37_sales_boot_fast_undo.sql
-- Run the whole file in the Supabase SQL editor. The last result is a quick check.
-- =====================================================================
begin;

drop function if exists public.sales_boot();

create function public.sales_boot()
 returns json
 language plpgsql
 stable
 security invoker
 set search_path to 'public'
as $function$
declare
  v_t    uuid;
  v_su   boolean := false;
  v_f    boolean;             -- filter by tenant explicitly?
  outs   text[] := '{}';
  part   text;
  cols   text;
  r      record;
  rel    regclass;
  has_t  boolean;
  wh     text;
begin
  v_t := (select current_tenant());
  begin
    select coalesce(p.is_superadmin, false) into v_su from profiles p where p.id = auth.uid();
  exception when undefined_column then v_su := false; end;
  v_f := v_t is not null and not coalesce(v_su, false);

  -- Plain tables: (order, table, columns to leave out, columns to keep only, order by, extra where)
  for r in select * from (values
    ( 1, 'trackings',                  array['tenant_id','contract_terms'], null::text[], 'created_at desc, id', null::text),
    ( 3, 'tracking_products',          array['tenant_id'], null, 'id', null),
    ( 4, 'tracking_potential_services',array['tenant_id'], null, 'id', null),
    ( 7, 'tracking_handovers',         array['tenant_id'], null, 'created_at', null),
    (10, 'sales_roles',                null, null, 'sort, created_at', null),
    (11, 'sales_access_rules',         null, array['subject_type','subject_id','settings'], '', null),
    (12, 'sales_visibility',           null, array['profile_id','scope'], '', null),
    (13, 'profiles',                   null, array['id','first_name','last_name','email','role','is_superadmin'], '', null),
    (20, 'pipelines',                  null, null, 'created_at', null),
    (21, 'pipeline_phases',            null, null, 'created_at', null),
    (22, 'pipeline_links',             null, null, '', null),
    (23, 'pipeline_phase_departments', null, null, '', null),
    (24, 'pipeline_phase_items',       null, null, '', null),
    (30, 'products',                   null, null, 'created_at', null),
    (31, 'product_tiers',              null, null, 'sort', null),
    (32, 'product_tier_durations',     null, null, 'sort', null),
    (33, 'services',                   null, null, 'created_at', null),
    (34, 'service_roles',              null, null, 'sort', null),
    (35, 'calculators',                null, null, '', null),
    (36, 'calculator_variables',       null, null, 'sort', null)
  ) v(n, tbl, excl, only_cols, ord, extra) order by n loop
    rel := to_regclass('public.' || r.tbl);
    if rel is null then continue; end if;
    select string_agg('x.' || quote_ident(a.attname), ', ' order by a.attnum)
      into cols
      from pg_attribute a
     where a.attrelid = rel and a.attnum > 0 and not a.attisdropped
       and (r.only_cols is null or a.attname = any(r.only_cols))
       and (r.excl is null or a.attname <> all(r.excl));
    if cols is null then continue; end if;
    has_t := exists (select 1 from pg_attribute where attrelid = rel and attname = 'tenant_id' and not attisdropped);
    wh := case when v_f and has_t then 'where x.tenant_id = $1' else '' end;
    begin
      execute format(
        'select coalesce(json_agg(row_to_json(s)), ''[]''::json)::text from (select %s from public.%I x %s %s) s',
        cols, r.tbl, wh,
        case when r.ord <> '' then 'order by ' || (select string_agg('x.' || trim(o), ', ') from unnest(string_to_array(r.ord, ',')) o) else '' end)
        into part using v_t;
      outs := outs || (to_json(r.tbl)::text || ':' || part);
    exception when undefined_column or undefined_table then null; end;
  end loop;

  -- Deal ↔ contacts and deal ↔ team: same rows as before (only the needed columns).
  for r in select * from (values
    ('tracking_contacts',  'x.tracking_id, x.contact_id', ''),
    ('tracking_employees', 'x.tracking_id, x.profile_id, x.is_owner', 'order by x.tracking_id, x.profile_id')
  ) v(tbl, cols, ord) loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    begin
      execute format('select coalesce(json_agg(row_to_json(s)), ''[]''::json)::text from (select %s from public.%I x %s %s) s',
        r.cols, r.tbl, case when v_f then 'where x.tenant_id = $1' else '' end, r.ord) into part using v_t;
      outs := outs || (to_json(r.tbl)::text || ':' || part);
    exception when undefined_column or undefined_table then
      begin  -- no tenant_id column: rely on row security alone
        execute format('select coalesce(json_agg(row_to_json(s)), ''[]''::json)::text from (select %s from public.%I x %s) s', r.cols, r.tbl, r.ord) into part;
        outs := outs || (to_json(r.tbl)::text || ':' || part);
      exception when undefined_column or undefined_table then null; end;
    end;
  end loop;

  -- Phase history, one entry per deal: {tracking_id, phase_ids[]}
  if to_regclass('public.tracking_phase_events') is not null then
    begin
      execute format('select coalesce(json_agg(json_build_object(''tracking_id'', g.tracking_id, ''phase_ids'', g.ids)), ''[]''::json)::text
                        from (select x.tracking_id, array_agg(x.phase_id) ids from public.tracking_phase_events x
                               where x.tracking_id is not null and x.phase_id is not null %s group by x.tracking_id) g',
        case when v_f then 'and x.tenant_id = $1' else '' end) into part using v_t;
      outs := outs || ('"tracking_phase_events":' || part);
    exception when undefined_column or undefined_table then
      begin
        select coalesce(json_agg(json_build_object('tracking_id', x.tracking_id, 'phase_id', x.phase_id)), '[]'::json)::text into part from tracking_phase_events x;
        outs := outs || ('"tracking_phase_events":' || part);
      exception when undefined_column or undefined_table then null; end;
    end;
  end if;

  -- Only the companies behind the deals (the full directory loads afterwards).
  if to_regclass('public.companies') is not null then
    begin
      execute format('select coalesce(json_agg(row_to_json(c) order by c.name), ''[]''::json)::text from public.companies c
                       where c.id in (select t.company_id from public.trackings t where t.company_id is not null %s) %s',
        case when v_f then 'and t.tenant_id = $1' else '' end,
        case when v_f then 'and c.tenant_id = $1' else '' end) into part using v_t;
      outs := outs || ('"companies":' || part);
    exception when undefined_column or undefined_table then null; end;
  end if;

  -- Who is asking
  begin
    select json_build_object('id', p.id, 'role', p.role, 'is_superadmin', p.is_superadmin)::text into part
      from profiles p where p.id = auth.uid();
    outs := outs || ('"me":' || coalesce(part, 'null'));
  exception when undefined_column then
    select json_build_object('id', p.id, 'role', p.role, 'is_superadmin', false)::text into part from profiles p where p.id = auth.uid();
    outs := outs || ('"me":' || coalesce(part, 'null'));
  end;

  return ('{' || array_to_string(outs, ',') || '}')::json;
end;
$function$;

grant execute on function public.sales_boot() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sales_boot() to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';

commit;

-- quick check (runs as you, the SQL editor user: may be empty there — that's fine)
select 'sales_boot replaced' as done,
       pg_get_function_result('public.sales_boot()'::regprocedure) as returns;
