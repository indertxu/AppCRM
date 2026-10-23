-- =====================================================================
-- 37_sales_boot_fast_undo.sql — put back sales_boot() exactly as it was before 37
-- (verbatim copy of the live definition you sent, returning jsonb).
-- The app works with both versions. Run the whole file.
-- =====================================================================
begin;
drop function if exists public.sales_boot();
CREATE OR REPLACE FUNCTION public.sales_boot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  out  jsonb := '{}'::jsonb;
  part jsonb;
begin
  -- Deals and what hangs off them -------------------------------------------
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc, t.id), '[]'::jsonb)
    into part from trackings t;
  out := out || jsonb_build_object('trackings', part);

  begin
    select coalesce(jsonb_agg(jsonb_build_object('tracking_id', x.tracking_id, 'contact_id', x.contact_id)), '[]'::jsonb)
      into part from tracking_contacts x;
    out := out || jsonb_build_object('tracking_contacts', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into part from tracking_products x;
    out := out || jsonb_build_object('tracking_products', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into part from tracking_potential_services x;
    out := out || jsonb_build_object('tracking_potential_services', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(jsonb_build_object('tracking_id', x.tracking_id, 'profile_id', x.profile_id, 'is_owner', x.is_owner)
                              order by x.tracking_id, x.profile_id), '[]'::jsonb)
      into part from tracking_employees x;
    out := out || jsonb_build_object('tracking_employees', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(jsonb_build_object('tracking_id', x.tracking_id, 'phase_id', x.phase_id)), '[]'::jsonb)
      into part from tracking_phase_events x;
    out := out || jsonb_build_object('tracking_phase_events', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) into part from tracking_handovers x;
    out := out || jsonb_build_object('tracking_handovers', part);
  exception when undefined_table or undefined_column then null; end;

  -- Only the companies behind the deals (the full directory loads afterwards).
  begin
    select coalesce(jsonb_agg(to_jsonb(c) order by c.name), '[]'::jsonb) into part
      from companies c
     where c.id in (select t.company_id from trackings t where t.company_id is not null);
    out := out || jsonb_build_object('companies', part);
  exception when undefined_table or undefined_column then null; end;

  -- Who sees what -------------------------------------------------------------
  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.created_at), '[]'::jsonb) into part from sales_roles x;
    out := out || jsonb_build_object('sales_roles', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(jsonb_build_object('subject_type', x.subject_type, 'subject_id', x.subject_id, 'settings', x.settings)), '[]'::jsonb)
      into part from sales_access_rules x;
    out := out || jsonb_build_object('sales_access_rules', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(jsonb_build_object('profile_id', x.profile_id, 'scope', x.scope)), '[]'::jsonb)
      into part from sales_visibility x;
    out := out || jsonb_build_object('sales_visibility', part);
  exception when undefined_table or undefined_column then null; end;

  -- People ------------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
           'email', p.email, 'role', p.role, 'is_superadmin', p.is_superadmin)), '[]'::jsonb)
    into part from profiles p;
  out := out || jsonb_build_object('profiles', part);

  select jsonb_build_object('id', p.id, 'role', p.role, 'is_superadmin', p.is_superadmin)
    into part from profiles p where p.id = auth.uid();
  out := out || jsonb_build_object('me', part);

  -- Pipelines and phases ----------------------------------------------------
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) into part from pipelines x;
  out := out || jsonb_build_object('pipelines', part);

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) into part from pipeline_phases x;
  out := out || jsonb_build_object('pipeline_phases', part);

  begin
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into part from pipeline_links x;
    out := out || jsonb_build_object('pipeline_links', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into part from pipeline_phase_departments x;
    out := out || jsonb_build_object('pipeline_phase_departments', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into part from pipeline_phase_items x;
    out := out || jsonb_build_object('pipeline_phase_items', part);
  exception when undefined_table or undefined_column then null; end;

  -- Catalog (for the potential revenue of each deal) ------------------------
  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) into part from products x;
    out := out || jsonb_build_object('products', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]'::jsonb) into part from product_tiers x;
    out := out || jsonb_build_object('product_tiers', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]'::jsonb) into part from product_tier_durations x;
    out := out || jsonb_build_object('product_tier_durations', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) into part from services x;
    out := out || jsonb_build_object('services', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]'::jsonb) into part from service_roles x;
    out := out || jsonb_build_object('service_roles', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into part from calculators x;
    out := out || jsonb_build_object('calculators', part);
  exception when undefined_table or undefined_column then null; end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]'::jsonb) into part from calculator_variables x;
    out := out || jsonb_build_object('calculator_variables', part);
  exception when undefined_table or undefined_column then null; end;

  return out;
end;
$function$
;
grant execute on function public.sales_boot() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sales_boot() to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
select 'sales_boot restored' as done, pg_get_function_result('public.sales_boot()'::regprocedure) as returns;
