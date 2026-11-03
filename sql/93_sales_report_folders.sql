-- =====================================================================
-- 93_sales_report_folders.sql — Folders for the saved reports
--
--   · sales_report_folders  each person's own folders (name, colour, order) and the
--                           reports in each (report_ids): anyone can file a report
--                           shared with them, without touching the report itself
-- Safe to run more than once.
-- =====================================================================
begin;

create table if not exists public.sales_report_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid default public.current_tenant(),
  owner_id uuid default auth.uid(),
  name text not null default 'New folder',
  color text,
  sort integer not null default 0,
  report_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists sales_report_folders_owner on public.sales_report_folders (owner_id, sort);

alter table public.sales_report_folders enable row level security;
drop policy if exists sales_report_folders_own on public.sales_report_folders;
create policy sales_report_folders_own on public.sales_report_folders for all to authenticated
  using (tenant_id = (select public.current_tenant()) and owner_id = (select auth.uid()))
  with check (tenant_id = (select public.current_tenant()) and owner_id = (select auth.uid()));
grant select, insert, update, delete on public.sales_report_folders to authenticated;

notify pgrst, 'reload schema';
commit;
