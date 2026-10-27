-- =====================================================================
-- 68_time_off.sql — time off, set up from Settings › Calendar
-- =====================================================================
--   timeoff_requests     what people ask for (made if it isn't there yet);
--                        gets "cancelled" as a status and who decided, when
--   timeoff_allowances   how many vacation days each person has, per year
--                        (no row = the company's default)
--   vacations.request_id the calendar days an approved request puts in
--   timeoff_list()       every request of the company, for the managers
--   timeoff_decide()     approve / decline / cancel a request (managers):
--                        approving a holiday puts its working days in the
--                        calendar; declining or cancelling takes them out
-- Managers: Boss, the department managers and superadmins.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

/* ---------- who may set up and decide on time off ---------- */
create or replace function public.timeoff_is_manager() returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and (coalesce(to_jsonb(p)->>'role', '') in ('boss', 'consultancy_manager', 'sales_manager', 'customer_success', 'customer_success_manager', 'it_manager', 'marketing_manager', 'hr_manager')
            or coalesce(to_jsonb(p)->>'is_superadmin', 'false') = 'true')
  )
$$;
grant execute on function public.timeoff_is_manager() to authenticated;

/* ---------- requests ---------- */
create table if not exists public.timeoff_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  user_id uuid not null default auth.uid(),
  kind text not null default 'vacation',
  from_date date not null,
  to_date date not null,
  half_day boolean not null default false,
  days numeric not null default 0,
  note text,
  status text not null default 'pending',
  decision_note text,
  created_at timestamptz not null default now()
);
alter table public.timeoff_requests add column if not exists tenant_id uuid;
alter table public.timeoff_requests add column if not exists decision_note text;
alter table public.timeoff_requests add column if not exists decided_by uuid;
alter table public.timeoff_requests add column if not exists decided_at timestamptz;

-- status: pending | approved | declined | cancelled
do $$ declare c record; begin
  for c in select conname from pg_constraint
            where conrelid = 'public.timeoff_requests'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%status%' loop
    execute format('alter table public.timeoff_requests drop constraint %I', c.conname);
  end loop;
  alter table public.timeoff_requests add constraint timeoff_requests_status_check check (status in ('pending', 'approved', 'declined', 'cancelled'));
end $$;

-- a new table: tenant + own rows (an existing one keeps its rules)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'timeoff_requests') then
    alter table public.timeoff_requests enable row level security;
    if to_regprocedure('public.set_tenant_id()') is not null then
      drop trigger if exists trg_set_tenant on public.timeoff_requests;
      create trigger trg_set_tenant before insert on public.timeoff_requests for each row execute function set_tenant_id();
    end if;
    create policy "timeoff: read own" on public.timeoff_requests for select to authenticated using (user_id = auth.uid());
    create policy "timeoff: ask" on public.timeoff_requests for insert to authenticated with check (user_id = auth.uid());
    create policy "timeoff: withdraw pending" on public.timeoff_requests for delete to authenticated using (user_id = auth.uid() and status = 'pending');
    grant select, insert, delete on public.timeoff_requests to authenticated;
  end if;
end $$;

/* ---------- allowances: vacation days per person and year ---------- */
create table if not exists public.timeoff_allowances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  user_id uuid not null,
  year integer not null,
  days numeric not null,
  note text,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create unique index if not exists timeoff_allowances_one on public.timeoff_allowances (user_id, year);
alter table public.timeoff_allowances enable row level security;
do $$ begin
  if to_regprocedure('public.set_tenant_id()') is not null then
    drop trigger if exists trg_set_tenant on public.timeoff_allowances;
    create trigger trg_set_tenant before insert on public.timeoff_allowances for each row execute function set_tenant_id();
  end if;
end $$;
drop policy if exists "allowances: read" on public.timeoff_allowances;
drop policy if exists "allowances: managers write" on public.timeoff_allowances;
create policy "allowances: read" on public.timeoff_allowances for select to authenticated
  using (user_id = auth.uid() or (tenant_id = public.current_tenant() and public.timeoff_is_manager()));
create policy "allowances: managers write" on public.timeoff_allowances for all to authenticated
  using (tenant_id = public.current_tenant() and public.timeoff_is_manager())
  with check (tenant_id = public.current_tenant() and public.timeoff_is_manager());
grant select, insert, update, delete on public.timeoff_allowances to authenticated;

/* ---------- the calendar days an approved request adds ---------- */
do $$ begin
  if to_regclass('public.vacations') is not null then
    alter table public.vacations add column if not exists request_id uuid;
  end if;
end $$;

/* The company of a request: its own tenant_id, or its person's. */
create or replace function public.timeoff_tenant(r jsonb) returns text language sql stable security definer set search_path = public as $$
  select coalesce(r->>'tenant_id', (select to_jsonb(p)->>'tenant_id' from public.profiles p where p.id = (r->>'user_id')::uuid))
$$;
revoke all on function public.timeoff_tenant(jsonb) from public, anon, authenticated;

/* ---------- every request of the company (managers) ---------- */
create or replace function public.timeoff_list(p_from date default null) returns setof jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.timeoff_is_manager() then return; end if;
  return query
    select to_jsonb(t) from public.timeoff_requests t
     where public.timeoff_tenant(to_jsonb(t)) = public.current_tenant()::text
       and (p_from is null or t.to_date >= p_from)
     order by t.from_date desc;
end $$;
grant execute on function public.timeoff_list(date) to authenticated;

/* ---------- approve / decline / cancel (managers) ---------- */
create or replace function public.timeoff_decide(p_id uuid, p_status text, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r jsonb; d date; n int := 0;
begin
  if not public.timeoff_is_manager() then return 'Only managers can decide on time off.'; end if;
  if p_status not in ('approved', 'declined', 'cancelled', 'pending') then return 'Unknown status.'; end if;
  select to_jsonb(t) into r from public.timeoff_requests t where id = p_id;
  if r is null or public.timeoff_tenant(r) is distinct from public.current_tenant()::text then return 'This request is not there any more.'; end if;

  update public.timeoff_requests
     set status = p_status, decision_note = nullif(btrim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now()
   where id = p_id;

  -- the calendar: an approved holiday's working days (not weekends, not public holidays)
  if to_regclass('public.vacations') is not null then
    delete from public.vacations where request_id = p_id;
    if p_status = 'approved' and coalesce(r->>'kind', 'vacation') = 'vacation' then
      for d in select g::date from generate_series((r->>'from_date')::date, (r->>'to_date')::date, interval '1 day') as g loop
        continue when extract(isodow from d) > 5;
        continue when to_regclass('public.holidays') is not null and exists (
          select 1 from public.holidays h where h.holiday_date = d
             and coalesce(to_jsonb(h)->>'tenant_id', public.current_tenant()::text) = public.current_tenant()::text);
        continue when exists (select 1 from public.vacations v where v.user_id = (r->>'user_id')::uuid and v.vacation_date = d);
        begin
          insert into public.vacations (user_id, vacation_date, request_id) values ((r->>'user_id')::uuid, d, p_id);
          n := n + 1;
        exception when others then
          return 'Approved, but the days could not be put in the calendar: ' || sqlerrm;
        end;
      end loop;
    end if;
  end if;
  return null;
end $$;
grant execute on function public.timeoff_decide(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;

select (select count(*) from public.timeoff_requests) as requests,
       (select count(*) from public.timeoff_allowances) as allowances;
