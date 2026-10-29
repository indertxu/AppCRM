-- =====================================================================
-- 76_calendar_series.sql — recurring entries in the calendar
-- =====================================================================
-- An entry can repeat: "every Monday 9:00–10:00", "every 2 weeks on Tue and
-- Thu", "every weekday", until a date or with no end. Works for client work
-- and for internal time alike.
--   · calendar_series keeps the rule (which weekdays, every how many weeks,
--     from / until) and what every occurrence carries (type, client, project,
--     tasks, notes, colleagues…)
--   · every occurrence is a normal row of calendar_entries with series_id set,
--     so billing, targets, invoices and Outlook treat it like any other entry
--   · series with no end are topped up when the calendar opens (filled_until)
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.calendar_series (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  user_id uuid not null default auth.uid(),
  every_weeks int not null default 1 check (every_weeks between 1 and 8),
  weekdays int[] not null default '{1}',          -- 0 = Sunday … 6 = Saturday
  start_date date not null,
  until_date date,                                 -- null = no end
  filled_until date,                               -- last date already turned into entries
  start_min int not null,
  end_min int not null,
  skip_off boolean not null default true,          -- skip holidays and days off
  template jsonb not null default '{}'::jsonb,     -- what each occurrence carries
  created_at timestamptz not null default now()
);
alter table public.calendar_series add column if not exists filled_until date;
alter table public.calendar_series add column if not exists skip_off boolean not null default true;
create index if not exists calendar_series_user on public.calendar_series (user_id);

do $$ begin
  if to_regprocedure('public.set_tenant_id()') is not null then
    drop trigger if exists trg_set_tenant on public.calendar_series;
    create trigger trg_set_tenant before insert on public.calendar_series for each row execute function set_tenant_id();
  end if;
end $$;

-- each person manages their own series; the workspace can read them (like entries)
alter table public.calendar_series enable row level security;
drop policy if exists "series: own" on public.calendar_series;
create policy "series: own" on public.calendar_series for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
do $$ begin
  drop policy if exists "series: read in workspace" on public.calendar_series;
  if to_regprocedure('public.current_tenant()') is not null then
    create policy "series: read in workspace" on public.calendar_series for select to authenticated
      using (tenant_id = public.current_tenant());
  end if;
end $$;
grant select, insert, update, delete on public.calendar_series to authenticated;

-- the occurrences point back at their series (an entry outlives its series)
alter table public.calendar_entries add column if not exists series_id uuid references public.calendar_series(id) on delete set null;
create index if not exists calendar_entries_series on public.calendar_entries (series_id, entry_date) where series_id is not null;

notify pgrst, 'reload schema';
commit;

select (select count(*) from public.calendar_series) as series,
       (select count(*) from public.calendar_entries where series_id is not null) as recurring_entries;
