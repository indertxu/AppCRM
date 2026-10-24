-- =====================================================================
-- 46_health.sql — why is everything slow? (and quick fix)
-- =====================================================================
-- 1. Stops any of my clean-up queries (43/44/45) that may still be running
--    in the background and eating the database.
-- 2. Refreshes the table statistics (ANALYZE) after the big imports and
--    clean-ups, so Postgres picks fast plans again.
-- 3. Shows what is running right now, waiting locks, and table health.
-- Deletes nothing. Safe to run any number of times.
-- =====================================================================
do $$
declare r record; n int := 0; t text;
begin
  -- 1. cancel leftover clean-up queries (only ours)
  for r in
    select pid from pg_stat_activity
    where pid <> pg_backend_pid() and state <> 'idle'
      and now() - query_start > interval '30 seconds'
      and (query ilike '%\_x43%' or query ilike '%\_x44%' or query ilike '%\_x45%'
           or query ilike '%deals_bk4%' or query ilike '%similarity(%')
  loop
    perform pg_cancel_backend(r.pid);
    n := n + 1;
  end loop;
  raise notice 'Cancelled % leftover queries.', n;

  -- 2. fresh statistics
  foreach t in array array['trackings','companies','contacts','clients','projects',
                           'tracking_contacts','deal_proposals','crm_options','profiles',
                           'client_products','invoices','tasks','activities'] loop
    if to_regclass('public.' || t) is not null then
      execute format('analyze public.%I', t);
    end if;
  end loop;
  raise notice 'Statistics refreshed.';
end $$;

-- 3. what is running / waiting right now + table health (one result)
select 'RUNNING' as what,
       pid::text as id,
       round(extract(epoch from now() - query_start))::text || ' s' as how_long,
       coalesce(wait_event_type || ':' || wait_event, state) as status,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) as detail
from pg_stat_activity
where pid <> pg_backend_pid() and state <> 'idle' and backend_type = 'client backend'
union all
select 'LOCK WAIT', l.pid::text, null, l.mode, l.relation::regclass::text
from pg_locks l where not l.granted
union all
select 'TABLE', relname,
       pg_size_pretty(pg_total_relation_size(relid)),
       n_live_tup || ' rows / ' || n_dead_tup || ' dead',
       'last analyze: ' || coalesce(greatest(last_analyze, last_autoanalyze)::text, 'never')
from pg_stat_user_tables
where schemaname = 'public'
  and relname in ('trackings','companies','contacts','clients','projects','tracking_contacts','deal_proposals')
order by 1, 2;
