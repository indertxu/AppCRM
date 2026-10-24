-- =====================================================================
-- 43_deals_dedupe.sql — deals imported twice (Konsolidator only)
-- =====================================================================
-- The deals Excel went in twice, so many deals exist two (or more) times.
-- Two deals are the SAME deal when, in the Konsolidator tenant, they have:
--   * the same company (a deal without company: the same contact),
--   * the same pipeline,
--   * the same name (case, accents, spaces and punctuation don't count),
--   * the same day they were created.
-- If the copies have DIFFERENT amounts (both filled in), the group is kept
-- apart and nothing is done with it — you'll see it at the top of the list.
--
-- HOW TO USE
--   1. Run the whole file as it is: it only SHOWS what it would do.
--      First row = summary (groups, deals that would go, deals left).
--      Then 30 example groups: the one marked KEEP stays, the others are
--      merged into it. "attached" = what hangs from each copy.
--   2. If it looks right, change  'no'  to  'yes'  on the line marked
--      >>> MERGE THE DUPLICATES <<<  and run the whole file again.
--
-- WHICH ONE STAYS: the copy with the most work on it (proposals, tasks,
-- files, notes…, then the most fields filled in), then the one changed last.
-- WHAT THE MERGE DOES (all in one go — if anything fails, nothing changes):
--   * everything is backed up first (tables *_bk43);
--   * the copy that stays gets what only the others had: empty fields filled
--     in (nothing is overwritten), contacts / team it lacked, proposals, tasks,
--     files, notes that are not already on it. Product lines: only if the one
--     that stays has none (so the deal's value never doubles);
--   * then the other copies are deleted.
-- Undo: 43_deals_dedupe_undo.sql
-- =====================================================================

do $$
declare
  apply      text := 'no';   -- >>> MERGE THE DUPLICATES <<<  change 'no' to 'yes' after checking
  v_t        uuid := '11f85bbc-8ef6-442a-bc53-915949f9f013';   -- Konsolidator
  r          record;
  col        record;
  ix         record;
  n          bigint;
  left_refs  bigint;
  bk         text;
  cond       text;
  cmp        text;
  v_removed  bigint := 0;
  has_ct     boolean := to_regclass('public.tracking_contacts') is not null;
begin
  -- ---------------------------------------------------------------
  -- every table/column that points at a deal (real foreign keys, plus
  -- uuid columns called tracking_id / *_tracking_id / deal_id)
  -- ---------------------------------------------------------------
  drop table if exists pg_temp._r43;
  create temp table _r43 as
  select distinct x.t, x.c from (
    select cl.relname::text t, att.attname::text c
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
    join unnest(con.conkey) k(attnum) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'f' and con.confrelid = 'public.trackings'::regclass
    union
    select table_name::text, column_name::text from information_schema.columns
    where table_schema = 'public' and data_type = 'uuid'
      and (column_name = 'tracking_id' or column_name like '%\_tracking\_id' or column_name = 'deal_id')
  ) x
  join information_schema.tables it on it.table_schema = 'public' and it.table_name = x.t and it.table_type = 'BASE TABLE'
  where x.t <> 'trackings' and x.t not like '%bk43%' and x.t not like '%\_bk%' and x.t not like '%backup%';

  -- ---------------------------------------------------------------
  -- the Konsolidator deals and what makes two of them the same deal
  -- ---------------------------------------------------------------
  drop table if exists pg_temp._d43;
  create temp table _d43 as
  select t.id,
         (to_jsonb(t) ->> 'company_id') as company_id,
         (to_jsonb(t) ->> 'pipeline_id') as pipeline_id,
         coalesce(to_jsonb(t) ->> 'deal_name', '') as deal_name,
         regexp_replace(lower(translate(coalesce(to_jsonb(t) ->> 'deal_name', ''),
           'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc')), '[^a-z0-9]+', '', 'g') as name_key,
         (t.created_at at time zone 'UTC')::date as created_day,
         (to_jsonb(t) ->> 'current_phase_id') as phase_id,
         (to_jsonb(t) ->> 'status') as status,
         nullif(to_jsonb(t) ->> 'product_price', '') as amount,
         coalesce((to_jsonb(t) ->> 'updated_at')::timestamptz, t.created_at) as changed,
         (select count(*) from jsonb_each(to_jsonb(t)) e
           where e.value not in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb)) as filled,
         null::text as who,
         '{}'::jsonb as attached,
         0::numeric as score
  from public.trackings t
  where (to_jsonb(t) ->> 'tenant_id')::uuid = v_t;

  update _d43 set who = 'co:' || company_id where company_id is not null;
  if has_ct then
    update _d43 d set who = 'ct:' || x.c
    from (select tc.tracking_id, min(tc.contact_id::text) c from public.tracking_contacts tc
          where tc.tracking_id in (select id from _d43 where who is null) group by tc.tracking_id) x
    where d.id = x.tracking_id and d.who is null;
  end if;
  update _d43 set who = 'id:' || id where who is null;   -- no company, no contact: never grouped
  create index on _d43 (id);

  -- what hangs from each deal (shown, and used to pick the one that stays)
  for r in select * from _r43 order by t, c loop
    execute format(
      'update _d43 d set attached = d.attached || jsonb_build_object(%L, x.n),
              score = d.score + x.n * %s
         from (select %I as id, count(*) n from public.%I where %I in (select id from _d43) group by 1) x
        where d.id = x.id',
      r.t || case when r.c = 'tracking_id' then '' else '.' || r.c end,
      case when r.t = 'deal_proposals' then 1000
           when r.t ~ '(task|file|ticket|calendar|meeting|mail)' then 100
           when r.t like 'tracking\_%' then 1 else 50 end,
      r.c, r.t, r.c);
  end loop;
  update _d43 set score = score + filled;

  -- ---------------------------------------------------------------
  -- the groups
  -- ---------------------------------------------------------------
  drop table if exists pg_temp._g43;
  create temp table _g43 as
  select who || '|' || coalesce(pipeline_id, '') || '|' || name_key || '|' || coalesce(created_day::text, '') as key,
         count(*) as n,
         count(distinct amount) filter (where amount is not null and amount::numeric <> 0) > 1 as apart,
         (array_agg(id order by score desc, changed desc nulls last, id))[1] as keeper
  from _d43
  where who not like 'id:%'
  group by 1
  having count(*) > 1;

  drop table if exists pg_temp._m43;
  create temp table _m43 as
  select d.id as loser, g.keeper, g.key
  from _d43 d
  join _g43 g on g.key = d.who || '|' || coalesce(d.pipeline_id, '') || '|' || d.name_key || '|' || coalesce(d.created_day::text, '')
  where not g.apart and d.id <> g.keeper;
  create index on _m43 (loser);
  create index on _m43 (keeper);

  drop table if exists pg_temp._s43;
  create temp table _s43 (mode text, deals_before bigint, groups bigint, groups_apart bigint, to_remove bigint, removed bigint, deals_after bigint);
  insert into _s43 values ('preview', (select count(*) from _d43), (select count(*) from _g43 where not apart),
                           (select count(*) from _g43 where apart), (select count(*) from _m43), 0, null);

  if apply is distinct from 'yes' then
    raise notice 'Preview only. To merge change ''no'' to ''yes'' on the line marked MERGE THE DUPLICATES.';
    return;
  end if;
  if not exists (select 1 from _m43) then
    update _s43 set mode = 'nothing to merge', deals_after = deals_before;
    raise notice 'Nothing to merge.';
    return;
  end if;

  -- ---------------------------------------------------------------
  -- 1. backups
  -- ---------------------------------------------------------------
  if to_regclass('public.trackings_bk43') is null then
    create table public.trackings_bk43 as select now() as bk43_at, t.* from public.trackings t where false;
    alter table public.trackings_bk43 enable row level security;
    create table public.deals_bk43_map (loser uuid, keeper uuid, bk43_at timestamptz default now());
    alter table public.deals_bk43_map enable row level security;
    create table public.deals_bk43_tables (tbl text, col text, bk text, primary key (tbl, col));
    alter table public.deals_bk43_tables enable row level security;
  end if;
  insert into public.deals_bk43_map (loser, keeper) select loser, keeper from _m43;
  insert into public.trackings_bk43
    select now(), t.* from public.trackings t
    where t.id in (select loser from _m43 union select keeper from _m43);

  for r in select * from _r43 loop
    bk := left('bk43_' || r.t || '__' || r.c, 63);
    if to_regclass('public.' || bk) is null then
      execute format('create table public.%I as select now() as bk43_at, x.* from public.%I x where false', bk, r.t);
      execute format('alter table public.%I enable row level security', bk);
    end if;
    insert into public.deals_bk43_tables values (r.t, r.c, bk) on conflict do nothing;
    execute format('insert into public.%I select now(), x.* from public.%I x where x.%I in (select loser from _m43)', bk, r.t, r.c);
  end loop;

  -- ---------------------------------------------------------------
  -- 2. the deal that stays gets the fields only the others have (never overwrites)
  -- ---------------------------------------------------------------
  for col in
    select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as typ
    from pg_attribute a
    where a.attrelid = 'public.trackings'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      and a.attname not in ('id', 'tenant_id', 'created_at', 'updated_at')
  loop
    execute format(
      'update public.trackings k set %1$I = l.%1$I
         from (select distinct on (m.keeper) m.keeper, x.%1$I
                 from _m43 m join public.trackings x on x.id = m.loser join _d43 d on d.id = m.loser
                where x.%1$I is not null and x.%1$I::text not in (%2$L, %3$L, %4$L, %5$L)
                order by m.keeper, d.score desc, d.id) l
        where k.id = l.keeper and (k.%1$I is null or k.%1$I::text in (%2$L, %3$L, %4$L, %5$L))',
      col.name, '', '{}', '[]', 'null');
  end loop;

  -- ---------------------------------------------------------------
  -- 3. what hangs from the other copies moves to the one that stays
  -- ---------------------------------------------------------------
  for r in select * from _r43 loop
    if r.t in ('tracking_products', 'tracking_potential_services') then
      -- product lines: only when the deal that stays has none, and from ONE copy only
      execute format(
        'update public.%1$I y set %2$I = m.keeper
           from _m43 m
          where y.%2$I = m.loser
            and not exists (select 1 from public.%1$I x where x.%2$I = m.keeper)
            and m.loser = (select m2.loser from _m43 m2 join _d43 d on d.id = m2.loser
                            where m2.keeper = m.keeper and exists (select 1 from public.%1$I z where z.%2$I = m2.loser)
                            order by d.score desc, d.id limit 1)', r.t, r.c);
    else
      -- the columns that say what a row IS (all but its id, the deal, the tenant and stamps)
      select string_agg(format('x.%1$I::text is not distinct from y.%1$I::text', a.attname), ' and ')
        into cmp
      from pg_attribute a
      where a.attrelid = ('public.' || quote_ident(r.t))::regclass and a.attnum > 0 and not a.attisdropped
        and a.attname not in (r.c, 'id', 'tenant_id', 'created_at', 'updated_at')
        and a.attname not in (select pa.attname from pg_index pi join pg_attribute pa on pa.attrelid = pi.indrelid and pa.attnum = any(pi.indkey)
                               where pi.indrelid = ('public.' || quote_ident(r.t))::regclass and pi.indisprimary
                                 and pa.attname <> r.c and array_length(pi.indkey::int2[], 1) = 1);
      cond := coalesce(cmp, 'true');
      -- unique keys on the deal column (e.g. contact + deal): never two equal rows on one deal
      for ix in
        select string_agg(format('x.%1$I::text is not distinct from y.%1$I::text', pa.attname), ' and ') filter (where pa.attname <> r.c) as eq
        from pg_index pi
        join pg_attribute pa on pa.attrelid = pi.indrelid and pa.attnum = any(pi.indkey)
        where pi.indrelid = ('public.' || quote_ident(r.t))::regclass and pi.indisunique and pi.indexprs is null
          and exists (select 1 from pg_attribute q where q.attrelid = pi.indrelid and q.attnum = any(pi.indkey) and q.attname = r.c)
        group by pi.indexrelid
      loop
        cond := cond || ' or (' || coalesce(ix.eq, 'true') || ')';
      end loop;
      -- move a row unless the deal that stays (or an earlier copy) already has an equal one
      execute format(
        'update public.%1$I y set %2$I = m.keeper
           from _m43 m
          where y.%2$I = m.loser
            and not exists (select 1 from public.%1$I x where x.%2$I = m.keeper and (%3$s))
            and not exists (select 1 from public.%1$I x join _m43 m2 on x.%2$I = m2.loser
                             where m2.keeper = m.keeper and (x.%2$I::text, x.ctid::text) < (y.%2$I::text, y.ctid::text) and (%3$s))',
        r.t, r.c, cond);
    end if;
    -- what is left on the other copies is a repeat: it goes (it is in the backup)
    execute format('delete from public.%I where %I in (select loser from _m43)', r.t, r.c);
  end loop;

  -- ---------------------------------------------------------------
  -- 4. nothing may still point at a copy that goes
  -- ---------------------------------------------------------------
  left_refs := 0;
  for r in select * from _r43 loop
    execute format('select count(*) from public.%I where %I in (select loser from _m43)', r.t, r.c) into n;
    left_refs := left_refs + n;
  end loop;
  if left_refs > 0 then raise exception '% rows still point at a deal that would go. Nothing was changed.', left_refs; end if;

  delete from public.trackings where id in (select loser from _m43);
  get diagnostics v_removed = row_count;

  update _s43 set mode = 'MERGED', removed = v_removed,
    deals_after = (select count(*) from public.trackings where (to_jsonb(trackings) ->> 'tenant_id')::uuid = v_t);
  raise notice 'Merged: % duplicate deals removed.', v_removed;
end $$;

-- ---------------------------------------------------------------------
-- the result: first the summary, then 30 example groups
-- ---------------------------------------------------------------------
select * from (
  select 0 as ord, 0 as grp,
         upper(s.mode) as what,
         format('deals now: %s · groups of the same deal: %s · deals that %s: %s · groups kept apart (amounts differ): %s%s',
                s.deals_before, s.groups, case when s.mode = 'MERGED' then 'went' else 'would go' end,
                case when s.mode = 'MERGED' then s.removed else s.to_remove end, s.groups_apart,
                case when s.mode = 'MERGED' then ' · deals left: ' || s.deals_after
                     else ' · deals left after merging: ' || (s.deals_before - s.to_remove) end) as deal,
         null::text as company, null::date as created, null::text as phase, null::text as status, null::text as amount,
         null::jsonb as attached, null::uuid as deal_id
  from _s43 s
  union all
  select 1, g.grp,
         case when g.apart then 'KEPT APART (amounts differ)' when d.id = g.keeper then 'KEEP' else 'remove (merged into KEEP)' end,
         d.deal_name, co.name, d.created_day, ph.name, d.status, d.amount, d.attached, d.id
  from (select *, dense_rank() over (order by apart desc, key) as grp from _g43) g
  join _d43 d on g.key = d.who || '|' || coalesce(d.pipeline_id, '') || '|' || d.name_key || '|' || coalesce(d.created_day::text, '')
  left join public.companies co on co.id::text = d.company_id
  left join lateral (select to_jsonb(p) ->> 'name' as name from public.pipeline_phases p where p.id::text = d.phase_id) ph on true
  where g.grp <= 30
) x
order by ord, grp, (what = 'KEEP') desc, what;
