-- =====================================================================
-- 63_page_data_scopes.sql — how much of each page's data people see
-- =====================================================================
-- Settings › <page> › Security: for each page, a default level for everyone
-- who can open it, then per department and per person (the most specific
-- wins). Bosses and superadmins always see everything.
--   rules = { "default": "all" | "department" | "mine" | "assigned" | "created",
--             "depts":   { "<dept_key>": level, … },
--             "users":   { "<profile id>": level, … } }
-- Copies the access rules of page_departments (61_custom_departments.sql),
-- else of crm_options. Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.page_data_scopes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  page text not null,
  rules jsonb not null default '{}'::jsonb,
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

drop trigger if exists trg_set_tenant on public.page_data_scopes;
create trigger trg_set_tenant before insert on public.page_data_scopes
  for each row execute function set_tenant_id();

do $$
declare n int;
begin
  n := pg_temp.copy_policies('page_departments', 'page_data_scopes');
  if n = 0 then n := pg_temp.copy_policies('crm_options', 'page_data_scopes'); end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'page_data_scopes') then
    create policy tenant_all on public.page_data_scopes for all to authenticated
      using (tenant_id = current_tenant()) with check (tenant_id = current_tenant());
  end if;
end $$;
grant select, insert, update, delete on public.page_data_scopes to authenticated;

notify pgrst, 'reload schema';
commit;

select page, rules from public.page_data_scopes order by page;
