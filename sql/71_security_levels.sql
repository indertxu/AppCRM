-- =====================================================================
-- 71_security_levels.sql — the company's own security levels
-- =====================================================================
-- Settings › Organization › Levels. Like departments, security levels can be
-- renamed, added (one for a new department, several inside a department) and
-- removed. A company starts with the built-in roles.
--   security_levels         name, department, order — and the built-in role it
--                           "works like" (base_role): what the app and the
--                           database check, so a new level never breaks a rule
--   profiles.security_level the level someone has (null = their department's);
--                           profiles.role follows it automatically (its base)
-- Page access, panels and data scopes can be set per level.
-- Removing a level: its people keep the permissions of its base role, and a
-- department that had it as default gets that role. Nothing else is deleted.
-- Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.security_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  level_key text not null,
  name text not null,
  dept_key text,                                   -- the department it belongs to (null = the whole company)
  base_role text not null default 'consultant',    -- the built-in role it works like
  color text,
  sort integer not null default 0,
  built_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists security_levels_key on public.security_levels (tenant_id, level_key);

do $$ declare c record; begin
  for c in select conname from pg_constraint
            where conrelid = 'public.security_levels'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%base_role%' loop
    execute format('alter table public.security_levels drop constraint %I', c.conname);
  end loop;
  alter table public.security_levels add constraint security_levels_base_check check (base_role in (
    'consultant', 'consultancy_manager', 'customer_success', 'customer_success_manager', 'sales', 'sales_manager',
    'it', 'it_manager', 'marketing', 'marketing_manager', 'hr', 'hr_manager', 'boss'));
end $$;

alter table public.profiles add column if not exists security_level text;

/* ---------- who reads and changes them: like the departments ---------- */
create or replace function pg_temp.copy_policies(src text, dst text) returns int language plpgsql as $$
declare p record; n int := 0;
begin
  execute format('alter table public.%I enable row level security', dst);
  for p in select * from pg_policies where schemaname = 'public' and tablename = src loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst and policyname = p.policyname) then n := n + 1; continue; end if;
    begin
      execute format('create policy %I on public.%I as %s for %s to %s %s %s',
        p.policyname, dst, p.permissive, p.cmd, array_to_string(p.roles, ', '),
        case when p.qual is not null then 'using (' || p.qual || ')' else '' end,
        case when p.with_check is not null then 'with check (' || p.with_check || ')' else '' end);
      n := n + 1;
    exception when others then
      raise notice 'policy % not copied to %: %', p.policyname, dst, sqlerrm;
    end;
  end loop;
  return n;
end $$;

do $$ declare n int; begin
  if to_regprocedure('public.set_tenant_id()') is not null then
    drop trigger if exists trg_set_tenant on public.security_levels;
    create trigger trg_set_tenant before insert on public.security_levels for each row execute function set_tenant_id();
  end if;
  n := pg_temp.copy_policies('org_departments', 'security_levels');
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'security_levels') then
    create policy tenant_all on public.security_levels for all to authenticated
      using (tenant_id = current_tenant()) with check (tenant_id = current_tenant());
  end if;
end $$;
grant select, insert, update, delete on public.security_levels to authenticated;

/* ---------- someone's level sets their role (the level's base) ---------- */
create or replace function public.profiles_level_role() returns trigger language plpgsql security definer set search_path = public as $$
declare b text; t text := to_jsonb(new)->>'tenant_id';
begin
  if new.security_level is null or new.security_level = '' then new.security_level := null; return new; end if;
  select base_role into b from public.security_levels
   where level_key = new.security_level and (t is null or tenant_id is null or tenant_id::text = t)
   order by (tenant_id::text = t) desc nulls last limit 1;
  if b is not null then new.role := b; end if;
  return new;
end $$;
drop trigger if exists trg_profiles_level_role on public.profiles;
create trigger trg_profiles_level_role before insert or update of security_level on public.profiles
  for each row execute function public.profiles_level_role();

/* ---------- a level that works like another role: its people follow ---------- */
create or replace function public.security_levels_follow() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.base_role is distinct from old.base_role then
      update public.profiles p set role = new.base_role
       where p.security_level = new.level_key
         and (new.tenant_id is null or to_jsonb(p)->>'tenant_id' = new.tenant_id::text);
    end if;
    new.updated_at := now();
    return new;
  end if;
  -- removed: its people keep its base role, departments that had it get that role
  update public.profiles p set security_level = null, role = old.base_role
   where p.security_level = old.level_key
     and (old.tenant_id is null or to_jsonb(p)->>'tenant_id' = old.tenant_id::text);
  update public.org_departments d set security_role = old.base_role
   where d.security_role = old.level_key
     and (old.tenant_id is null or to_jsonb(d)->>'tenant_id' is null or to_jsonb(d)->>'tenant_id' = old.tenant_id::text);
  return old;
end $$;
drop trigger if exists trg_security_levels_update on public.security_levels;
create trigger trg_security_levels_update before update on public.security_levels
  for each row execute function public.security_levels_follow();
drop trigger if exists trg_security_levels_delete on public.security_levels;
create trigger trg_security_levels_delete after delete on public.security_levels
  for each row execute function public.security_levels_follow();

/* ---------- a department removed: its levels stay, for the whole company ---------- */
create or replace function public.org_departments_free_levels() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.security_levels l set dept_key = null
   where l.dept_key = old.dept_key
     and (to_jsonb(old)->>'tenant_id' is null or l.tenant_id::text = to_jsonb(old)->>'tenant_id');
  return old;
end $$;
drop trigger if exists trg_org_departments_free_levels on public.org_departments;
create trigger trg_org_departments_free_levels after delete on public.org_departments
  for each row execute function public.org_departments_free_levels();

notify pgrst, 'reload schema';
commit;

select (select count(*) from public.security_levels) as levels,
       (select count(*) from public.profiles where security_level is not null) as people_with_a_level;
