-- =====================================================================
-- 73_outlook_events.sql — entries logged from an Outlook event
-- =====================================================================
-- The calendars show your Outlook events as grey blocks (read from Outlook, not
-- stored). "Log it" turns one into an entry; outlook_source_id keeps the id of the
-- Outlook event it came from, so the event isn't shown twice and the entry is
-- never written back over it (outlook_event_id stays for events the CRM creates).
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
alter table public.calendar_entries add column if not exists outlook_source_id text;
create index if not exists calendar_entries_outlook_source on public.calendar_entries (user_id, outlook_source_id) where outlook_source_id is not null;
notify pgrst, 'reload schema';
commit;

select count(*) filter (where outlook_source_id is not null) as logged_from_outlook from public.calendar_entries;
