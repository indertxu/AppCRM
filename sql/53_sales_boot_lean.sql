-- =====================================================================
-- 53_sales_boot_lean.sql — the Deals page opens with much less data
-- =====================================================================
-- sales_boot() answered 27 MB for 9,200 deals, and the page then also
-- downloaded every company and every contact of the directory (≈36 MB more).
-- This version:
--   * sends the big lists (deals, their lines, contacts, team) as columns +
--     rows instead of repeating every field name on every row (the app reads
--     both shapes);
--   * sends only what the list shows of the deals' companies (name, logo site,
--     city…); a deal's full company is read when you open the deal;
--   * adds deal_contact_names(): name and e-mail of the people on deals, so the
--     page no longer needs the whole contact directory.
-- Same deals, same rules of who sees what (row security).
-- Safe: it only replaces / adds functions. Undo: run 37_sales_boot_fast.sql again.
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
  v_f    boolean;
  outs   text[] := '{}';
  part   text;
  names  text[];
  cols   text;
  r      record;
  rel    regclass;
  has_t  boolean;
  wh     text;
  ord    text;
begin
  v_t := (select current_tenant());
  begin
    select coalesce(p.is_superadmin, false) into v_su from profiles p where p.id = auth.uid();
  exception when undefined_column then v_su := false; end;
  v_f := v_t is not null and not coalesce(v_su, false);

  -- (order, table, columns to leave out, columns to keep only, order by, packed as columns + rows?)
  for r in select * from (values
    ( 1, 'trackings',                  array['tenant_id','contract_terms'], null::text[], 'created_at desc, id', true),
    ( 2, 'tracking_contacts',          null, array['tracking_id','contact_id'], '', true),
    ( 3, 'tracking_products',          array['tenant_id'], null, 'id', true),
    ( 4, 'tracking_potential_services',array['tenant_id'], null, 'id', false),
    ( 5, 'tracking_employees',         null, array['tracking_id','profile_id','is_owner'], 'tracking_id, profile_id', true),
    ( 7, 'tracking_handovers',         array['tenant_id'], null, 'created_at', false),
    (10, 'sales_roles',                null, null, 'sort, created_at', false),
    (11, 'sales_access_rules',         null, array['subject_type','subject_id','settings'], '', false),
    (12, 'sales_visibility',           null, array['profile_id','scope'], '', false),
    (13, 'profiles',                   null, array['id','first_name','last_name','email','role','is_superadmin'], '', false),
    (20, 'pipelines',                  null, null, 'created_at', false),
    (21, 'pipeline_phases',            null, null, 'created_at', false),
    (22, 'pipeline_links',             null, null, '', false),
    (23, 'pipeline_phase_departments', null, null, '', false),
    (24, 'pipeline_phase_items',       null, null, '', false),
    (30, 'products',                   null, null, 'created_at', false),
    (31, 'product_tiers',              null, null, 'sort', false),
    (32, 'product_tier_durations',     null, null, 'sort', false),
    (33, 'services',                   null, null, 'created_at', false),
    (34, 'service_roles',              null, null, 'sort', false),
    (35, 'calculators',                null, null, '', false),
    (36, 'calculator_variables',       null, null, 'sort', false)
  ) v(n, tbl, excl, only_cols, ordby, packed) order by n loop
    rel := to_regclass('public.' || r.tbl);
    if rel is null then continue; end if;
    select array_agg(a.attname::text order by a.attnum)
      into names
      from pg_attribute a
     where a.attrelid = rel and a.attnum > 0 and not a.attisdropped
       and (r.only_cols is null or a.attname = any(r.only_cols))
       and (r.excl is null or a.attname <> all(r.excl));
    if names is null then continue; end if;
    cols := (select string_agg('x.' || quote_ident(nm), ', ') from unnest(names) nm);
    has_t := exists (select 1 from pg_attribute where attrelid = rel and attname = 'tenant_id' and not attisdropped);
    wh := case when v_f and has_t then 'where x.tenant_id = $1' else '' end;
    ord := case when r.ordby <> '' then 'order by ' || (select string_agg('x.' || trim(o), ', ') from unnest(string_to_array(r.ordby, ',')) o) else '' end;
    begin
      if r.packed then
        -- {"c": [field names], "r": [[values], …]}: the names are sent once
        execute format('select json_build_object(''c'', %L::json, ''r'', coalesce(json_agg(json_build_array(%s) %s), ''[]''::json))::text from public.%I x %s',
          to_json(names)::text, cols, ord, r.tbl, wh) into part using v_t;
      else
        execute format('select coalesce(json_agg(row_to_json(s)), ''[]''::json)::text from (select %s from public.%I x %s %s) s',
          cols, r.tbl, wh, ord) into part using v_t;
      end if;
      outs := outs || (to_json(r.tbl)::text || ':' || part);
    exception when undefined_column or undefined_table then null; end;
  end loop;

  -- Phase history, one entry per deal: {tracking_id, phase_ids[]}
  if to_regclass('public.tracking_phase_events') is not null then
    begin
      execute format('select coalesce(json_agg(json_build_object(''tracking_id'', g.tracking_id, ''phase_ids'', g.ids)), ''[]''::json)::text
                        from (select x.tracking_id, array_agg(x.phase_id) ids from public.tracking_phase_events x
                               where x.tracking_id is not null and x.phase_id is not null %s group by x.tracking_id) g',
        case when v_f then 'and x.tenant_id = $1' else '' end) into part using v_t;
      outs := outs || ('"tracking_phase_events":' || part);
    exception when undefined_column or undefined_table then null; end;
  end if;

  -- The deals' companies: only what the list shows (the full company is read when a deal opens)
  if to_regclass('public.companies') is not null then
    select string_agg('c.' || quote_ident(a.attname), ', ' order by a.attnum) into cols
      from pg_attribute a
     where a.attrelid = 'public.companies'::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname in ('id', 'name', 'legal_name', 'website', 'city', 'country', 'sector', 'vat_number', 'relationship', 'parent_id');
    begin
      execute format('select coalesce(json_agg(row_to_json(s) order by s.name), ''[]''::json)::text from (select %s from public.companies c
                       where c.id in (select t.company_id from public.trackings t where t.company_id is not null %s) %s) s',
        cols,
        case when v_f then 'and t.tenant_id = $1' else '' end,
        case when v_f then 'and c.tenant_id = $1' else '' end) into part using v_t;
      outs := outs || ('"companies":' || part);
    exception when undefined_column or undefined_table then null; end;
  end if;

  begin
    select json_build_object('id', p.id, 'role', p.role, 'is_superadmin', p.is_superadmin)::text into part
      from profiles p where p.id = auth.uid();
    outs := outs || ('"me":' || coalesce(part, 'null'));
  exception when undefined_column then
    select json_build_object('id', p.id, 'role', p.role, 'is_superadmin', false)::text into part from profiles p where p.id = auth.uid();
    outs := outs || ('"me":' || coalesce(part, 'null'));
  end;

  -- tells the app it may skip the full directories (companies, contacts)
  outs := outs || '"lean":true'::text;
  return ('{' || array_to_string(outs, ',') || '}')::json;
end;
$function$;
grant execute on function public.sales_boot() to authenticated;

-- Name, e-mail and position of the people on deals you can see: [[id, first, last, email, position], …]
create or replace function public.deal_contact_names()
returns json
language sql stable security invoker
set search_path to 'public'
as $$
  select coalesce(json_agg(json_build_array(c.id, c.first_name, c.last_name, c.email, c.position)), '[]'::json)
  from public.contacts c
  where c.tenant_id = (select current_tenant())
    and c.id in (select tc.contact_id from public.tracking_contacts tc)
$$;
grant execute on function public.deal_contact_names() to authenticated;

notify pgrst, 'reload schema';
commit;

select 'sales_boot is lean now' as done;
