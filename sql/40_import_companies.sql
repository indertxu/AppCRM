-- =====================================================================
-- 40_import_companies.sql — fast imports of big files (companies & contacts)
-- =====================================================================
-- The importer creates new records in batches (500 per request). Records that
-- are already in the CRM each get their own small update; with thousands of
-- them that was thousands of requests one after another (the "stuck at 0 %").
-- This function applies a whole batch of those updates in ONE request.
--
--   import_update_rows('companies', '[{"id": "...", "set": {"city": "Madrid"},
--                                      "add_relationship": ["Partner"]}, …]')
--
-- * Runs as the signed-in user (SECURITY INVOKER): row security applies, so it
--   can only touch the records that user can already edit.
-- * Only the tables companies and contacts; never id, tenant, created/imported stamps.
-- * add_relationship only ADDS company types (never removes one).
-- * A row that fails (or that isn't there / that user can't edit) doesn't stop
--   the others; it comes back in "errors".
-- Safe to run more than once. The app works without it (slower, row by row).
-- =====================================================================

create or replace function public.import_update_rows(p_table text, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  r        jsonb;
  allowed  text[];
  cols     text;
  rel_type text;
  ok       int := 0;
  n        int;
  errs     jsonb := '[]'::jsonb;
begin
  if p_table not in ('companies', 'contacts') then
    raise exception 'import_update_rows: table % is not allowed', p_table;
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    return jsonb_build_object('ok', 0, 'errors', '[]'::jsonb);
  end if;

  select array_agg(column_name::text) into allowed
  from information_schema.columns
  where table_schema = 'public' and table_name = p_table
    and column_name not in ('id', 'tenant_id', 'created_at', 'created_by', 'imported_by', 'imported_at', 'import_batch_id');

  if p_table = 'companies' then
    select data_type into rel_type from information_schema.columns
    where table_schema = 'public' and table_name = 'companies' and column_name = 'relationship';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    begin
      if (r ->> 'id') is null then
        raise exception 'no id';
      end if;

      select string_agg(format('%1$I = s.%1$I', k), ', ') into cols
      from jsonb_object_keys(coalesce(r -> 'set', '{}'::jsonb)) k
      where k = any (allowed);

      if cols is not null then
        execute format(
          'update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) s where t.id = $2',
          p_table, cols, p_table)
        using r -> 'set', (r ->> 'id')::uuid;
        get diagnostics n = row_count;
        if n = 0 then raise exception 'not found, or you can''t edit it'; end if;
      end if;

      if p_table = 'companies' and rel_type is not null
         and jsonb_typeof(r -> 'add_relationship') = 'array' and jsonb_array_length(r -> 'add_relationship') > 0 then
        if rel_type = 'ARRAY' then
          update public.companies c
             set relationship = (select array_agg(distinct x) from unnest(coalesce(c.relationship, '{}'::text[])
                                   || array(select jsonb_array_elements_text(r -> 'add_relationship'))) x)
           where c.id = (r ->> 'id')::uuid;
          get diagnostics n = row_count;
        else
          update public.companies c
             set relationship = (select jsonb_agg(distinct x) from (
                                   select jsonb_array_elements_text(case when jsonb_typeof(to_jsonb(c.relationship)) = 'array' then to_jsonb(c.relationship) else '[]'::jsonb end) x
                                   union select jsonb_array_elements_text(r -> 'add_relationship')) s)
           where c.id = (r ->> 'id')::uuid;
          get diagnostics n = row_count;
        end if;
        if n = 0 then raise exception 'not found, or you can''t edit it'; end if;
      end if;

      ok := ok + 1;
    exception when others then
      errs := errs || jsonb_build_object('id', r ->> 'id', 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', ok, 'errors', errs);
end
$$;

revoke all on function public.import_update_rows(text, jsonb) from public, anon;
grant execute on function public.import_update_rows(text, jsonb) to authenticated;

-- indexes the importer's look-ups use (cheap if they're already there)
create index if not exists companies_import_assignees_idx on public.company_assignees (company_id);
create index if not exists contacts_import_assignees_idx on public.contact_assignees (contact_id);

notify pgrst, 'reload schema';

select 'import_update_rows installed' as result;
