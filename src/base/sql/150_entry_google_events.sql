-- 150 · BASE · Calendar entries copied to Google Calendar
-- Every entry you log also lands in each Google account with Calendar on (Settings › Integrations)
-- that My calendars shows. The event each account got is kept here, so editing the entry updates
-- that event and deleting the entry removes it, instead of making a new one every time.
-- { "<connected_accounts.id>": "<Google event id>", … }
-- Additive only: Enterprise ignores the column.
alter table public.calendar_entries
  add column if not exists google_event_ids jsonb not null default '{}'::jsonb;
