-- =====================================================================
-- 58_project_hold_dates.sql — when a project went on hold and came back
-- =====================================================================
-- Each project keeps its pauses: [{ "from": "2026-10-12", "to": "2026-11-03" }, …]
-- ("to" empty while it is still on hold). They are written when you change
-- the status (Open / On hold / Closed) and can be edited in the project panel.
-- Time on hold is left out of the average project length (Management › Backlog).
-- Projects already on hold get a pause starting today (edit the date in the panel).
-- Run 57_project_on_hold.sql first. Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;

alter table public.projects add column if not exists hold_periods jsonb not null default '[]'::jsonb;

update public.projects
   set hold_periods = jsonb_build_array(jsonb_build_object('from', to_char(current_date, 'YYYY-MM-DD'), 'to', null))
 where status = 'on_hold' and (hold_periods is null or hold_periods = '[]'::jsonb);

notify pgrst, 'reload schema';
commit;

select count(*) filter (where status = 'on_hold') as on_hold_now,
       count(*) filter (where jsonb_array_length(hold_periods) > 0) as with_pauses
from public.projects;
