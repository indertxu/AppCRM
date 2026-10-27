-- =====================================================================
-- 70_dept_tables.sql — Management › Department: tables
-- =====================================================================
-- dept_items can now be a table (kind "table"): rows and columns kept in
-- the department's directory (users & access, contacts…), the sheet as
-- JSON in body. Needs 65_department_drive.sql. Nothing is deleted.
-- Safe to run more than once.
-- =====================================================================
begin;
do $$ declare c record; begin
  if to_regclass('public.dept_items') is null then raise exception 'Run 65_department_drive.sql first.'; end if;
  for c in select conname from pg_constraint
            where conrelid = 'public.dept_items'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%kind%' loop
    execute format('alter table public.dept_items drop constraint %I', c.conname);
  end loop;
  alter table public.dept_items add constraint dept_items_kind_check check (kind in ('file', 'link', 'note', 'table'));
end $$;
notify pgrst, 'reload schema';
commit;

select pg_get_constraintdef(oid) as kinds from pg_constraint where conname = 'dept_items_kind_check';
