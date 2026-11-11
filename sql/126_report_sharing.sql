-- 126_report_sharing.sql  ·  Reports belong to their owner, who shares them with people.
--
-- A saved report (sales_reports) has one owner. The owner can:
--   • share it with the whole team (shared = true — as before: everyone may view it),
--   • share it with people: shared_with (they may view it) and editors (they may also change it in place),
--   • hand it over: make someone else the owner.
-- Only the owner changes who it's shared with and who owns it (a trigger keeps those columns as they were
-- for anyone else); only the owner deletes it. Each person still sees only the records they may see.
-- Whoever gets it shared, or becomes its owner, gets a notification (Home bell) that opens the report.
-- Additive: two columns, policies widened, a guard trigger and an alert trigger.

alter table public.sales_reports add column if not exists shared_with uuid[] not null default '{}';
alter table public.sales_reports add column if not exists editors uuid[] not null default '{}';
create index if not exists ix126_sales_reports_shared_with on public.sales_reports using gin (shared_with);
create index if not exists ix126_sales_reports_editors on public.sales_reports using gin (editors);

drop policy if exists sales_reports_select on public.sales_reports;
create policy sales_reports_select on public.sales_reports for select using (
  tenant_id = (select current_tenant())
  and (owner_id = (select auth.uid()) or shared or (select auth.uid()) = any (shared_with) or (select auth.uid()) = any (editors))
);
drop policy if exists sales_reports_update on public.sales_reports;
create policy sales_reports_update on public.sales_reports for update using (
  tenant_id = (select current_tenant())
  and (owner_id = (select auth.uid()) or (select auth.uid()) = any (editors))
) with check (tenant_id = (select current_tenant()));

-- only the owner changes the owner and the sharing
create or replace function public.sales_reports_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and old.owner_id is distinct from auth.uid() then
    new.owner_id := old.owner_id;
    new.shared := old.shared;
    new.shared_with := old.shared_with;
    new.editors := old.editors;
  end if;
  new.shared_with := coalesce(new.shared_with, '{}');
  new.editors := coalesce(new.editors, '{}');
  return new;
end $$;
drop trigger if exists trg126_sales_reports_guard on public.sales_reports;
create trigger trg126_sales_reports_guard before update on public.sales_reports
  for each row execute function public.sales_reports_guard();

-- who gets it shared (or becomes its owner) is told
create or replace function public.alert_report_shared() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_old uuid[] := case when tg_op = 'UPDATE' then coalesce(old.shared_with, '{}') || coalesce(old.editors, '{}') || array[old.owner_id] else array[new.owner_id] end;
begin
  for v_user in select distinct u from unnest(coalesce(new.shared_with, '{}') || coalesce(new.editors, '{}')) u where u is not null and not (u = any (v_old)) and u is distinct from new.owner_id
  loop
    perform public.alert_push(v_user, new.tenant_id, 'report_shared', coalesce(nullif(new.name, ''), 'A report'),
      case when v_user = any (coalesce(new.editors, '{}')) then 'You can view and change it' else 'You can view it' end, 'report', new.id, null);
  end loop;
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id then
    perform public.alert_push(new.owner_id, new.tenant_id, 'report_owner', coalesce(nullif(new.name, ''), 'A report'), 'It is yours now', 'report', new.id, null);
  end if;
  return new;
end $$;
drop trigger if exists trg126_report_shared on public.sales_reports;
create trigger trg126_report_shared after insert or update of shared_with, editors, owner_id on public.sales_reports
  for each row execute function public.alert_report_shared();
