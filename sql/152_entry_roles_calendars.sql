-- =====================================================================
-- 152 · Calendar entries: the same time on several roles, and which calendars get it (Enterprise)
--
--   split_of   the entry this one was split from: logging 1 h as Senior Consultant and also as
--              Connector makes the first entry (the one on the calendar) and one more per extra
--              role, each with its own role_id and billable. They move, change status and go with
--              it (on delete cascade); Outlook / Google only get the first one.
--   calendars  { "outlook": bool, "google": [connected_accounts.id, …] } — which of your calendars
--              get the entry; null = all of them (as before).
-- Additive only; Base ignores both columns.
-- =====================================================================
alter table public.calendar_entries
  add column if not exists split_of uuid references public.calendar_entries (id) on delete cascade;
alter table public.calendar_entries
  add column if not exists calendars jsonb;
create index if not exists calendar_entries_split_of on public.calendar_entries (split_of) where split_of is not null;
