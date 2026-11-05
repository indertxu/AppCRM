-- =====================================================================
-- 100_tenant_plan.sql — two tiers of the app: Enterprise (full) and Base (simple)
-- =====================================================================
-- tenants.plan decides which app a company's users get after signing in:
--   'enterprise' → the full app (src/components/…), every existing company
--   'base'       → the simple app (src/base/…): Home, Calendar, Tasks, People, Clients, Settings
-- Same login, same database, same tables. Set by the superadmin (company page / New company).
-- my_plan() is how the app reads it right after sign-in (any signed-in user, own company only).
-- Safe to run more than once.
-- =====================================================================
alter table public.tenants add column if not exists plan text not null default 'enterprise';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_plan_check') then
    alter table public.tenants add constraint tenants_plan_check check (plan in ('enterprise', 'base'));
  end if;
end $$;

create or replace function public.my_plan()
returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce((select t.plan from public.tenants t where t.id = public.current_tenant()), 'enterprise');
$$;
revoke all on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;

notify pgrst, 'reload schema';

-- the superadmin switches a company between the two apps (company page, New company)
create or replace function public.sa_set_plan(p_tenant uuid, p_plan text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_superadmin() then raise exception 'Not authorized'; end if;
  if p_plan not in ('enterprise', 'base') then raise exception 'Unknown plan %', p_plan; end if;
  update public.tenants set plan = p_plan where id = p_tenant;
end $$;
revoke all on function public.sa_set_plan(uuid, text) from public, anon;
grant execute on function public.sa_set_plan(uuid, text) to authenticated;

-- the console's company list shows each company's plan
do $$ declare d text := pg_get_functiondef('public.sa_dashboard'::regproc); begin
  if position('t.created_at, t.plan,' in d) = 0 then
    execute replace(d, 'select t.id, t.name, t.active, t.max_users, t.created_at,', 'select t.id, t.name, t.active, t.max_users, t.created_at, t.plan,');
  end if;
end $$;
