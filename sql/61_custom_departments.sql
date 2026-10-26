-- =====================================================================
-- 61_custom_departments.sql — your own departments, and page access by department
-- =====================================================================
-- 1. org_departments gets a name, a colour, a mark and an order, so departments
--    can be created, renamed and removed in Settings → Organization (the seven
--    original ones keep their key and get their usual name and look).
-- 2. page_departments: for each page, the departments that can open it
--    ("*" = everyone). A page without a row keeps the earlier rules.
--    Bosses and superadmins always open everything; Home and Settings always open.
-- page_departments copies the access rules of page_access_rules (who may
-- change page access), else of crm_options. Nothing is deleted.
-- Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

-- ---------- 1. departments: name, colour, mark, order ----------
alter table public.org_departments add column if not exists name text;
alter table public.org_departments add column if not exists color text;
alter table public.org_departments add column if not exists icon text;
alter table public.org_departments add column if not exists sort integer;

update public.org_departments d set
  name  = coalesce(nullif(trim(d.name), ''), v.name),
  color = coalesce(d.color, v.color),
  icon  = coalesce(d.icon, v.icon),
  sort  = coalesce(d.sort, v.sort)
from (values
  ('consultancy',      'Consultancy',      '#12b57f', '◆', 0),
  ('human_resources',  'Human Resources',  '#e0798c', '♥', 1),
  ('marketing',        'Marketing',        '#e0a13c', '◈', 2),
  ('sales',            'Sales',            '#3c9ae0', '▲', 3),
  ('customer_success', 'Customer Success', '#9b6fd0', '★', 4),
  ('it',               'IT',               '#4a5568', '❖', 5),
  ('management',       'Management',       '#0a6f4d', '◉', 6)
) as v(dept_key, name, color, icon, sort)
where d.dept_key = v.dept_key;

-- any other department: its key made readable
update public.org_departments
   set name = initcap(replace(dept_key, '_', ' '))
 where coalesce(trim(name), '') = '';

-- ---------- 2. page access by department ----------
create table if not exists public.page_departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  page text not null,
  dept_keys text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (tenant_id, page)
);

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

drop trigger if exists trg_set_tenant on public.page_departments;
create trigger trg_set_tenant before insert on public.page_departments
  for each row execute function set_tenant_id();

do $$
declare n int;
begin
  n := pg_temp.copy_policies('page_access_rules', 'page_departments');
  if n = 0 then n := pg_temp.copy_policies('crm_options', 'page_departments'); end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'page_departments') then
    create policy tenant_all on public.page_departments for all to authenticated
      using (tenant_id = current_tenant()) with check (tenant_id = current_tenant());
  end if;
end $$;
grant select, insert, update, delete on public.page_departments to authenticated;

-- a removed department leaves no trace in the page lists (only in its own company)
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'org_departments' and column_name = 'tenant_id') then
    create or replace function public.org_departments_forget() returns trigger
    language plpgsql security definer set search_path = public as $f$
    begin
      update public.page_departments
         set dept_keys = array_remove(dept_keys, old.dept_key), updated_at = now()
       where tenant_id is not distinct from old.tenant_id and old.dept_key = any(dept_keys);
      return old;
    end $f$;
  else
    create or replace function public.org_departments_forget() returns trigger
    language plpgsql security definer set search_path = public as $f$
    begin
      update public.page_departments
         set dept_keys = array_remove(dept_keys, old.dept_key), updated_at = now()
       where tenant_id is not distinct from current_tenant() and old.dept_key = any(dept_keys);
      return old;
    end $f$;
  end if;
end $$;
drop trigger if exists trg_org_departments_forget on public.org_departments;
create trigger trg_org_departments_forget after delete on public.org_departments
  for each row execute function public.org_departments_forget();

notify pgrst, 'reload schema';
commit;

select dept_key, name, color, icon, sort from public.org_departments order by sort nulls last, name;
