-- =====================================================================
-- 25_clients_merge_konsolidator_undo.sql — undo 25_clients_merge_konsolidator.sql
-- =====================================================================
-- Puts back the 4 deleted clients, returns their products (and anything else
-- that was moved) and restores the 4 kept clients as they were before.
-- Uses the backups clients_bk25_clients / clients_bk25_moved.
-- =====================================================================
begin;

do $$
declare r record; sets text;
begin
  if to_regclass('public.clients_bk25_clients') is null then
    raise exception 'No backup found (clients_bk25_clients). Nothing to undo.';
  end if;

  -- 1. the deleted clients come back
  insert into public.clients
  select b.* from public.clients_bk25_clients b
  where not exists (select 1 from public.clients c where c.id = b.id);

  -- 2. moved rows point at their original client again (matched by id)
  for r in select distinct m0.tbl, m0.col from public.clients_bk25_moved m0 loop
    execute format(
      'update public.%I t set %I = m.loser
         from public.clients_bk25_moved m
        where m.tbl = %L and m.col = %L and (m.row_data ->> ''id'') = t.id::text',
      r.tbl, r.col, r.tbl, r.col);
  end loop;

  -- 3. the kept clients get their old values back
  select string_agg(format('%1$I = b.%1$I', column_name), ', ') into sets
  from information_schema.columns
  where table_schema = 'public' and table_name = 'clients' and column_name not in ('id');
  execute format('update public.clients c set %s from public.clients_bk25_clients b where b.id = c.id', sets);

  raise notice 'Undo done.';
end $$;

commit;

select c.id, c.name from public.clients c
where c.id in (select id from public.clients_bk25_clients) order by c.name;
