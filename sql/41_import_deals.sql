-- =====================================================================
-- 41_import_deals.sql — fast, safe import of big deal files
-- =====================================================================
-- Actions → Import deals saves 500 deals per request. Without this file each
-- batch takes six requests (the deals, then their contacts, product lines,
-- team, phase dates and notes). With it, ONE request saves the 500 deals and
-- everything they carry, and every deal is all-or-nothing: a deal is never left
-- without its contact or its phase dates.
--
--   import_deals_batch('[{"deal": {"id": "...", "company_id": "...", ...},
--                         "contacts":  [{"contact_id": "..."}],
--                         "products":  [{"product_id": "...", "price": 0, "partner_id": "..."}],
--                         "employees": [{"profile_id": "...", "is_owner": true}],
--                         "events":    [{"phase_id": "...", "entered_at": "2024-01-01T09:00:00Z"}],
--                         "notes":     [{"phase_id": "...", "body": "..."}]}, …]')
--
-- * Runs as the signed-in user (SECURITY INVOKER): row security applies, so it
--   only writes what that user could write from the app.
-- * The app makes the deal ids, so sending a batch twice (a lost answer, a
--   stopped import run again) never doubles a deal: one already there is
--   reported in "already" and left as it is.
-- * Columns your database doesn't have yet are left out (listed in "dropped");
--   tenant and import stamps are never taken from the request.
-- * A deal that fails doesn't stop the others; it comes back in "errors".
-- * A deal the CRM already has (same company, pipeline, title and day it was
--   created) is not saved twice: it comes back in "matched" with the id of the
--   one already there — unless the row says "allow_duplicate": true (the
--   importer's "import duplicates too" choice).
--
-- Also lets import_update_rows (40_import_companies.sql) update deals, for
-- "Update the deals already in the CRM". Run 40 first if you haven't.
-- Safe to run more than once. The app works without it (a bit slower).
-- =====================================================================

create or replace function public.import_deals_batch(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  r        jsonb;
  d        jsonb;
  kids     jsonb;
  cols     text;
  allowed  jsonb := '{}'::jsonb;   -- table → its columns
  dropped  text[] := '{}';
  ok       int := 0;
  errs     jsonb := '[]'::jsonb;
  already  jsonb := '[]'::jsonb;
  matched  jsonb := '[]'::jsonb;   -- [{id, existing}]: the same deal already in the CRM
  twin     uuid;
  kind     text;
  tbl      text;
  pairs    constant text[][] := array[
    array['contacts',  'tracking_contacts'],
    array['products',  'tracking_products'],
    array['employees', 'tracking_employees'],
    array['events',    'tracking_phase_events'],
    array['notes',     'tracking_notes']];
  i        int;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    return jsonb_build_object('ok', 0, 'already', '[]'::jsonb, 'errors', '[]'::jsonb, 'dropped', '[]'::jsonb);
  end if;

  -- the columns each table has (never the tenant or the import stamps)
  select coalesce(jsonb_object_agg(t, c), '{}'::jsonb) into allowed
  from (
    select table_name::text t, jsonb_agg(column_name::text) c
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('trackings', 'tracking_contacts', 'tracking_products', 'tracking_employees', 'tracking_phase_events', 'tracking_notes')
      and column_name not in ('tenant_id', 'imported_by', 'imported_at')
    group by table_name
  ) x;

  -- what the request sends that the database doesn't have (left out)
  select coalesce(array_agg(distinct k), '{}') into dropped
  from jsonb_array_elements(p_rows) e, jsonb_object_keys(coalesce(e.value -> 'deal', '{}'::jsonb)) k
  where not coalesce(allowed -> 'trackings', '[]'::jsonb) ? k;
  for i in 1 .. array_length(pairs, 1) loop
    kind := pairs[i][1]; tbl := pairs[i][2];
    if allowed ? tbl then
      dropped := dropped || coalesce((
        select array_agg(distinct k)
        from jsonb_array_elements(p_rows) e, jsonb_array_elements(coalesce(e.value -> kind, '[]'::jsonb)) c, jsonb_object_keys(c.value) k
        where not (allowed -> tbl) ? k), '{}');
    elsif exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_array_length(coalesce(e.value -> kind, '[]'::jsonb)) > 0) then
      dropped := dropped || tbl;
    end if;
  end loop;

  for r in select value from jsonb_array_elements(p_rows) loop
    d := r -> 'deal';
    begin
      if (d ->> 'id') is null then raise exception 'no id'; end if;

      -- saved by an earlier try (same id): leave it as it is
      if exists (select 1 from public.trackings t where t.id = (d ->> 'id')::uuid) then
        already := already || to_jsonb(d ->> 'id');
        continue;
      end if;

      -- the same deal is already in the CRM (same company, pipeline, title and day it was
      -- created): not saved again, whatever the app read beforehand. Only saved anyway when
      -- the person chose "import duplicates too" (allow_duplicate).
      if not coalesce((r ->> 'allow_duplicate')::boolean, false)
         and (d ->> 'company_id') is not null and (d ->> 'created_at') is not null then
        select t.id into twin
        from public.trackings t
        where t.company_id = (d ->> 'company_id')::uuid
          and (to_jsonb(t) ->> 'pipeline_id') is not distinct from (d ->> 'pipeline_id')
          and (t.created_at at time zone 'UTC')::date = ((d ->> 'created_at')::timestamptz at time zone 'UTC')::date
          and regexp_replace(lower(translate(coalesce(to_jsonb(t) ->> 'deal_name', ''),
                'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc')), '[^a-z0-9]+', '', 'g')
            = regexp_replace(lower(translate(coalesce(d ->> 'deal_name', ''),
                'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc')), '[^a-z0-9]+', '', 'g')
        limit 1;
        if twin is not null then
          matched := matched || jsonb_build_object('id', d ->> 'id', 'existing', twin);
          twin := null;
          continue;
        end if;
      end if;

      select string_agg(quote_ident(k), ', ') into cols
      from jsonb_object_keys(d) k
      where (allowed -> 'trackings') ? k;
      execute format('insert into public.trackings (%1$s) select %1$s from jsonb_populate_record(null::public.trackings, $1)', cols)
      using d;

      for i in 1 .. array_length(pairs, 1) loop
        kind := pairs[i][1]; tbl := pairs[i][2];
        if not allowed ? tbl or jsonb_array_length(coalesce(r -> kind, '[]'::jsonb)) = 0 then continue; end if;
        select jsonb_agg(c.value || jsonb_build_object('tracking_id', d ->> 'id')) into kids
        from jsonb_array_elements(r -> kind) c;
        select string_agg(quote_ident(k), ', ') into cols
        from (select distinct k from jsonb_array_elements(kids) c, jsonb_object_keys(c.value) k) x
        where (allowed -> tbl) ? k;
        execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1)', tbl, cols)
        using kids;
      end loop;

      ok := ok + 1;
    exception when others then
      errs := errs || jsonb_build_object('id', d ->> 'id', 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', ok, 'already', already, 'matched', matched, 'errors', errs, 'dropped', to_jsonb(dropped));
end
$$;

revoke all on function public.import_deals_batch(jsonb) from public, anon;
grant execute on function public.import_deals_batch(jsonb) to authenticated;

-- import_update_rows (from 40) can also update deals — only if 40 is installed
do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'import_update_rows' and pg_get_function_identity_arguments(p.oid) = 'p_table text, p_rows jsonb';
  if src is null then
    raise notice 'import_update_rows is not installed (40_import_companies.sql): deals already in the CRM are updated one by one.';
  elsif src not like '%''trackings''%' then
    execute replace(src, 'p_table not in (''companies'', ''contacts'')', 'p_table not in (''companies'', ''contacts'', ''trackings'')');
  end if;
end $$;

notify pgrst, 'reload schema';

select 'import_deals_batch installed' as result;
