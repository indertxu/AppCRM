-- =====================================================================
-- 84_internal_work_not_billed.sql — internal work never bills
-- =====================================================================
-- Calendar time booked on a work type that isn't client work (Internal,
-- Demo…) was saved with billable days (the length of the slot), and the
-- colleagues invited to it too. From now on the app saves 0 for these; this
-- puts the time already booked right. A copy of every changed row is kept in
-- bk84_* tables first. Safe to run more than once.
-- =====================================================================
begin;

create table if not exists public.bk84_calendar_entries as
  select e.id, e.billable from public.calendar_entries e where false;
create table if not exists public.bk84_entry_actuals as
  select a.entry_id, a.actual_billable from public.entry_actuals a where false;
create table if not exists public.bk84_entry_invites as
  select i.id, i.billable from public.entry_invites i where false;
-- copies only: nobody reads them through the app
alter table public.bk84_calendar_entries enable row level security;
alter table public.bk84_entry_actuals enable row level security;
alter table public.bk84_entry_invites enable row level security;

-- the entries: an internal type and no project
with t as (
  select e.id from public.calendar_entries e join public.work_types w on w.id = e.work_type_id
   where not w.client_related and e.project_id is null and coalesce(e.billable, 0) <> 0
)
insert into public.bk84_calendar_entries select e.id, e.billable from public.calendar_entries e join t using (id);
update public.calendar_entries e set billable = 0
  from public.work_types w
 where w.id = e.work_type_id and not w.client_related and e.project_id is null and coalesce(e.billable, 0) <> 0;

-- what was logged as actually done on them
insert into public.bk84_entry_actuals
  select a.entry_id, a.actual_billable from public.entry_actuals a
    join public.calendar_entries e on e.id = a.entry_id join public.work_types w on w.id = e.work_type_id
   where not w.client_related and e.project_id is null and coalesce(a.actual_billable, 0) <> 0;
update public.entry_actuals a set actual_billable = 0
  from public.calendar_entries e join public.work_types w on w.id = e.work_type_id
 where e.id = a.entry_id and not w.client_related and e.project_id is null and coalesce(a.actual_billable, 0) <> 0;

-- the colleagues invited to them
insert into public.bk84_entry_invites
  select i.id, i.billable from public.entry_invites i
    join public.calendar_entries e on e.id = i.entry_id join public.work_types w on w.id = e.work_type_id
   where not w.client_related and e.project_id is null and coalesce(i.billable, 0) <> 0;
update public.entry_invites i set billable = 0
  from public.calendar_entries e join public.work_types w on w.id = e.work_type_id
 where e.id = i.entry_id and not w.client_related and e.project_id is null and coalesce(i.billable, 0) <> 0;

commit;

select (select count(*) from public.bk84_calendar_entries) as entries_fixed,
       (select count(*) from public.bk84_entry_actuals) as actuals_fixed,
       (select count(*) from public.bk84_entry_invites) as invites_fixed;
