-- =====================================================================
-- 43_deals_dedupe_undo.sql — undo 43_deals_dedupe.sql
-- =====================================================================
-- Puts back the deals the merge removed, gives the deals that stayed their
-- fields as they were, and puts back everything that hung from the removed
-- ones (contacts, team, product lines, proposals, notes…) exactly as it was.
-- Uses the backups made by the merge (trackings_bk43, bk43_*). All in one go.
-- When it finishes, the backups are dropped (the merge can be run again).
-- =====================================================================

do $$
declare
  r      record;
  cols   text;
  sets   text;
  pk     text;
  n      bigint;
begin
  if to_regclass('public.trackings_bk43') is null then
    raise exception 'No backup found (trackings_bk43). Nothing to undo.';
  end if;

  -- the oldest backed-up version of each deal = how it was before any merge
  drop table if exists pg_temp._b43;
  create temp table _b43 as
  select distinct on (id) * from public.trackings_bk43 order by id, bk43_at;

  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
  from pg_attribute a
  where a.attrelid = 'public.trackings'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and exists (select 1 from pg_attribute b where b.attrelid = 'public.trackings_bk43'::regclass and b.attname = a.attname and not b.attisdropped);

  -- 1. the deals that were removed come back
  execute format('insert into public.trackings (%1$s) overriding system value
                  select %1$s from _b43 b where not exists (select 1 from public.trackings t where t.id = b.id)', cols);
  get diagnostics n = row_count;
  raise notice '% deals put back.', n;

  -- 2. the deals that stayed get their fields as they were
  select string_agg(format('%1$I = b.%1$I', a.attname), ', ') into sets
  from pg_attribute a
  where a.attrelid = 'public.trackings'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and a.attname <> 'id'
    and exists (select 1 from pg_attribute b where b.attrelid = 'public.trackings_bk43'::regclass and b.attname = a.attname and not b.attisdropped);
  execute format('update public.trackings t set %s from _b43 b where b.id = t.id', sets);

  -- 3. what hung from the removed deals: rows moved / removed by the merge are put back as they were
  for r in select * from public.deals_bk43_tables loop
    if to_regclass('public.' || quote_ident(r.bk)) is null or to_regclass('public.' || quote_ident(r.tbl)) is null then continue; end if;

    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
    from pg_attribute a
    where a.attrelid = ('public.' || quote_ident(r.tbl))::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      and exists (select 1 from pg_attribute b where b.attrelid = ('public.' || quote_ident(r.bk))::regclass and b.attname = a.attname and not b.attisdropped);

    -- the table's primary key (to find the same row again)
    select string_agg(quote_ident(pa.attname), ', ') into pk
    from pg_index pi join pg_attribute pa on pa.attrelid = pi.indrelid and pa.attnum = any(pi.indkey)
    where pi.indrelid = ('public.' || quote_ident(r.tbl))::regclass and pi.indisprimary;

    if pk is not null then
      -- a moved row has the same key, now pointing at the deal that stayed: take it away first
      execute format('delete from public.%1$I where (%2$s) in (select %2$s from public.%3$I)', r.tbl, pk, r.bk);
    else
      -- no primary key: a moved row is the same row now pointing at the deal that stayed
      select string_agg(format('x.%1$I::text is not distinct from b.%1$I::text', a.attname), ' and ') into sets
      from pg_attribute a
      where a.attrelid = ('public.' || quote_ident(r.tbl))::regclass and a.attnum > 0 and not a.attisdropped and a.attname <> r.col;
      execute format('delete from public.%1$I x using public.%2$I b, public.deals_bk43_map m
                       where m.loser = b.%3$I and x.%3$I = m.keeper and %4$s', r.tbl, r.bk, r.col, coalesce(sets, 'true'));
    end if;

    execute format('insert into public.%1$I (%2$s) overriding system value
                    select %2$s from (select distinct on (%4$s) * from public.%3$I order by %4$s, bk43_at) b',
                   r.tbl, cols, r.bk, coalesce(pk, 'ctid'));
  end loop;

  -- 4. done: the backups go (the merge can be run again later)
  for r in select * from public.deals_bk43_tables loop
    execute format('drop table if exists public.%I', r.bk);
  end loop;
  drop table public.deals_bk43_tables;
  drop table public.deals_bk43_map;
  drop table public.trackings_bk43;
  raise notice 'Undo done.';
end $$;

select 'undo finished' as result,
       (select count(*) from public.trackings where (to_jsonb(trackings) ->> 'tenant_id') = '11f85bbc-8ef6-442a-bc53-915949f9f013') as konsolidator_deals_now;
