-- 151 · BASE · Calendar invitations by e-mail, chosen per entry in the step-by-step pop-up
-- { "team": true,               -- colleagues on it also get an Outlook / Google invitation
--   "guests": false,            -- contacts / guests get one too (the client, say)
--   "emails": [{ "email": "...", "name": "..." }] }   -- guests typed by hand (not in the CRM)
-- Null on entries made elsewhere: those keep the old Outlook behaviour.
-- Gmail addresses are invited from the organiser's Google Calendar, the rest from their Outlook
-- (or everything from whichever of the two is connected) — see src/base/api/calendarPush.ts.
-- Additive only: Enterprise ignores the column.
alter table public.calendar_entries
  add column if not exists invite_mail jsonb;
