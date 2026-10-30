-- =====================================================================
-- 79_merge_records.sql — merge two contacts, or two companies, into one
-- =====================================================================
-- Contacts and Companies: tick two rows → "Merge". You choose which one stays
-- and which values it keeps (the app saves that first); then this moves
-- everything that pointed to the other one (deals, links to companies or
-- contacts, clients, notes, history, files…) onto the one that stays, and
-- deletes the other.
--   · It follows every foreign key to public.contacts / public.companies, so
--     tables added later are covered too.
--   · A row that would become a duplicate (e.g. the same contact linked twice
--     to the same company) is dropped instead of moved.
--   · Both records must be of your organisation.
-- Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

create or replace function public.merge_records(p_kind text, p_keep uuid, p_drop uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  tbl regclass;
  t record;
  r record;
  moved int := 0;
  dropped int := 0;
  n int;
  my_tenant uuid := public.current_tenant();
  keep_tenant uuid;
  drop_tenant uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'Pick two different records'; end if;
  if p_kind = 'company' then tbl := 'public.companies'::regclass;
  elsif p_kind = 'contact' then tbl := 'public.contacts'::regclass;
  else raise exception 'Unknown kind %', p_kind; end if;

  execute format('select tenant_id from %s where id = $1', tbl) into keep_tenant using p_keep;
  execute format('select tenant_id from %s where id = $1', tbl) into drop_tenant using p_drop;
  if keep_tenant is null or drop_tenant is null then raise exception 'Record not found'; end if;
  if keep_tenant is distinct from drop_tenant or (my_tenant is not null and keep_tenant is distinct from my_tenant) then
    raise exception 'Both records must be of your organisation';
  end if;

  -- every single-column foreign key that points at the table
  for t in
    select c.conrelid::regclass as rel, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = tbl and array_length(c.conkey, 1) = 1
  loop
    begin
      execute format('update %s set %I = $1 where %I = $2', t.rel, t.col, t.col) using p_keep, p_drop;
      get diagnostics n = row_count; moved := moved + n;
    exception when unique_violation then
      -- one row at a time: move it, or drop it when the one that stays already has the same
      for r in execute format('select ctid from %s where %I = $1', t.rel, t.col) using p_drop loop
        begin
          execute format('update %s set %I = $1 where ctid = $2', t.rel, t.col) using p_keep, r.ctid;
          moved := moved + 1;
        exception when unique_violation then
          execute format('delete from %s where ctid = $1', t.rel) using r.ctid;
          dropped := dropped + 1;
        end;
      end loop;
    end;
  end loop;

  -- a company can't be its own parent
  if p_kind = 'company' then
    update public.companies set parent_id = null where id = p_keep and parent_id = p_keep;
  end if;

  execute format('delete from %s where id = $1', tbl) using p_drop;
  return jsonb_build_object('moved', moved, 'dropped', dropped);
end $$;

revoke all on function public.merge_records(text, uuid, uuid) from public, anon;
grant execute on function public.merge_records(text, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

select 'merge_records ready' as status;
