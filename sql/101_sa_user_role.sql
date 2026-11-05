-- =====================================================================
-- 101_sa_user_role.sql — the superadmin changes someone's role in their company
-- =====================================================================
-- sa_roles(p_tenant): the roles a company can give (its security levels, Settings ›
--   Organization; the built-in list when it has none yet).
-- sa_set_role(p_user, p_level): gives that person the role, the same way the company's
--   own Settings does (security_level = the level, role = its base role).
-- Superadmin only; never another superadmin. Safe to run more than once.
-- =====================================================================
create or replace function public.sa_roles(p_tenant uuid)
returns table (level_key text, name text, base_role text, dept_key text, sort int)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_superadmin() then raise exception 'Not authorized'; end if;
  if exists (select 1 from public.security_levels s where s.tenant_id = p_tenant) then
    return query select s.level_key, s.name, s.base_role, s.dept_key, s.sort from public.security_levels s where s.tenant_id = p_tenant order by s.sort, s.name;
  else
    return query select * from (values
      ('consultant', 'Consultant', 'consultant', 'consultancy', 0), ('consultancy_manager', 'Consultancy manager', 'consultancy_manager', 'consultancy', 1),
      ('customer_success', 'Customer success', 'customer_success', 'customer_success', 2), ('customer_success_manager', 'CS manager', 'customer_success_manager', 'customer_success', 3),
      ('sales', 'Sales', 'sales', 'sales', 4), ('sales_manager', 'Sales manager', 'sales_manager', 'sales', 5),
      ('it', 'IT', 'it', 'it', 6), ('it_manager', 'IT manager', 'it_manager', 'it', 7),
      ('marketing', 'Marketing', 'marketing', 'marketing', 8), ('marketing_manager', 'Marketing manager', 'marketing_manager', 'marketing', 9),
      ('hr', 'Human resources', 'hr', 'human_resources', 10), ('hr_manager', 'HR manager', 'hr_manager', 'human_resources', 11),
      ('finance', 'Finance', 'finance', 'finance', 12), ('finance_manager', 'Finance manager', 'finance_manager', 'finance', 13),
      ('boss', 'Boss', 'boss', 'management', 14)) v(level_key, name, base_role, dept_key, sort);
  end if;
end $$;
revoke all on function public.sa_roles(uuid) from public, anon;
grant execute on function public.sa_roles(uuid) to authenticated;

create or replace function public.sa_set_role(p_user uuid, p_level text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare t uuid; sup boolean; lv record;
begin
  if not public.is_superadmin() then raise exception 'Not authorized'; end if;
  select tenant_id, coalesce(is_superadmin, false) into t, sup from public.profiles where id = p_user;
  if not found then raise exception 'No such user'; end if;
  if sup then raise exception 'A superadmin has no company role'; end if;
  select s.level_key, s.base_role into lv from public.security_levels s where s.tenant_id = t and s.level_key = p_level;
  if found then
    update public.profiles set security_level = lv.level_key, role = lv.base_role where id = p_user;
  elsif p_level in ('consultant','consultancy_manager','customer_success','customer_success_manager','sales','sales_manager','it','it_manager','marketing','marketing_manager','hr','hr_manager','finance','finance_manager','boss') then
    update public.profiles set security_level = null, role = p_level where id = p_user;
  else
    raise exception 'Unknown role %', p_level;
  end if;
end $$;
revoke all on function public.sa_set_role(uuid, text) from public, anon;
grant execute on function public.sa_set_role(uuid, text) to authenticated;

notify pgrst, 'reload schema';
