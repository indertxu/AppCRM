-- =====================================================================
-- 57_project_on_hold.sql — projects can be Open, On hold or Closed
-- =====================================================================
-- The Projects page now has a status picker: Open / On hold / Closed.
-- On hold is stored as projects.status = 'on_hold'.
-- If your database has a rule that only allows 'open' and 'closed', this
-- widens it to also allow 'on_hold'. If there is no such rule, nothing changes.
-- No data is changed or deleted. Safe to run more than once.
-- =====================================================================
begin;

do $$
declare c record; n int := 0;
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
    where con.conrelid = 'public.projects'::regclass and con.contype = 'c' and a.attname = 'status'
  loop
    if c.def ilike '%on_hold%' then continue; end if;
    execute format('alter table public.projects drop constraint %I', c.conname);
    n := n + 1;
  end loop;
  if n > 0 then
    alter table public.projects add constraint projects_status_check
      check (status is null or status in ('open', 'on_hold', 'closed', 'active', 'live')) not valid;
  end if;
  raise notice 'status rules widened: %', n;
end $$;

commit;

select coalesce(string_agg(pg_get_constraintdef(oid), ' | '), 'no rule on status (any value allowed)') as status_rule
from pg_constraint where conrelid = 'public.projects'::regclass and contype = 'c'
  and pg_get_constraintdef(oid) ilike '%status%';
