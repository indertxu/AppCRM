-- A name for every meeting and booking (calendar_entries.name), set when it is created —
-- in the Calendar's booking window and on a deal. Shown as its title everywhere (calendar,
-- the deal, Home, Outlook); without one, the old title is shown as before.
alter table public.calendar_entries add column if not exists name text;
notify pgrst, 'reload schema';
