-- =====================================================================
-- 148 · "In a deal that entered phase … since / before / between …" filter
--       (Enterprise · Companies, Contacts, Clients, Deals filters and Marketing audiences)
--
--  • phase_cond_sql(kind, cond)  → the WHERE piece for a filter of type 'phase'
--      kind 'company': deals of the company (trackings.company_id = c.id)
--      kind 'contact': deals the contact is on (tracking_contacts.contact_id = c.id)
--      cond = { op, values: [phase ids], min, max }   ops:
--        p_ever · p_since (min, inclusive) · p_before (min, exclusive) · p_between (min..max, inclusive)
--        p_last30 · p_last90 · p_year · p_never (hasn't entered any of them)
--      dates are the UTC day of tracking_phase_events.entered_at.
--  • companies_view_sql / contacts_view_sql: same as before, plus the 'phase' branch.
--  • deal_phase_index(): every deal of the tenant with its company, its contacts and when it entered
--      each phase — compact, for the pages that filter in the browser (Clients, Deals, Marketing).
--      { phases: [phase id…], deals: [[deal id, company id, [contact ids], [phase index, 'YYYY-MM-DD', …]], …] }
--      Security invoker: RLS decides what the caller sees.
-- Nothing is dropped or renamed. Base doesn't send 'phase' filters, so it's unaffected.
-- =====================================================================

create or replace function public.phase_cond_sql(p_kind text, c jsonb)
returns text language plpgsql immutable as $$
declare op text := c ->> 'op'; vals uuid[]; mn text := nullif(c ->> 'min', ''); mx text := nullif(c ->> 'max', '');
        link text; d text := '(e.entered_at at time zone ''UTC'')::date'; w text;
begin
  begin
    vals := array(select x::uuid from jsonb_array_elements_text(case when jsonb_typeof(c -> 'values') = 'array' then c -> 'values' else '[]'::jsonb end) x);
  exception when others then return null;
  end;
  if cardinality(vals) = 0 then return null; end if;                       -- unfinished: ignored
  if op in ('p_since', 'p_before') and mn is null then return null; end if;
  if op = 'p_between' and mn is null and mx is null then return null; end if;
  if mn is not null and mn !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  if mx is not null and mx !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;

  link := case p_kind
    when 'company' then 'join public.trackings t on t.id = e.tracking_id where t.company_id = c.id'
    when 'contact' then 'join public.tracking_contacts tc on tc.tracking_id = e.tracking_id where tc.contact_id = c.id'
    else null end;
  if link is null then return null; end if;

  w := case op
    when 'p_ever' then ''
    when 'p_never' then ''
    when 'p_since' then format(' and %s >= %L::date', d, mn)
    when 'p_before' then format(' and %s < %L::date', d, mn)
    when 'p_between' then coalesce(format(' and %s >= %L::date', d, mn), '') || coalesce(format(' and %s <= %L::date', d, mx), '')
    when 'p_last30' then format(' and %s >= current_date - 30', d)
    when 'p_last90' then format(' and %s >= current_date - 90', d)
    when 'p_year' then format(' and %s >= date_trunc(%L, current_date)::date', d, 'year')
    else null end;
  if w is null then return null; end if;

  return format('%sexists (select 1 from public.tracking_phase_events e %s and e.phase_id = any(%L::uuid[])%s)',
                case when op = 'p_never' then 'not ' else '' end, link, vals, w);
end $$;

create or replace function public.companies_view_sql(p_view jsonb, p_search text, p_ctx jsonb, OUT w text, OUT o text)
 RETURNS record
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare c jsonb; e text; s text; parts text[] := '{}'; ords text[] := '{}'; q text := btrim(public.fx_norm(p_search)); ty text; dir text;
begin
  for c in select * from jsonb_array_elements(case when jsonb_typeof(p_view -> 'conds') = 'array' then p_view -> 'conds' else '[]'::jsonb end) loop
    ty := coalesce(c ->> 'type', 'text');
    if ty = 'phase' then                                                    -- 148: entered a deal phase
      s := public.phase_cond_sql('company', c);
      if s is not null then parts := parts || ('(' || s || ')'); end if;
      continue;
    end if;
    e := public.companies_fx(c ->> 'field', ty, p_ctx);
    if e is null then continue; end if;
    s := public.list_cond_sql(e, ty, c);
    if s is not null then parts := parts || ('(' || s || ')'); end if;
  end loop;
  w := case when cardinality(parts) = 0 then 'true'
            when p_view ->> 'match' = 'any' then '(' || array_to_string(parts, ' or ') || ')'
            else array_to_string(parts, ' and ') end;
  -- LIKE (not strpos) so the trigram index on search is used
  if q <> '' then w := w || format(' and x.search like %L', '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'); end if;

  for c in select * from jsonb_array_elements(case when jsonb_typeof(p_view -> 'sort') = 'array' then p_view -> 'sort' else '[]'::jsonb end) loop
    dir := case when c ->> 'dir' = 'desc' then 'desc' else 'asc' end;
    ty := coalesce(c ->> 'type', 'text');
    if ty = 'phase' then continue; end if;
    if c ->> 'key' = 'name' then e := 'x.name_sort';
    elsif c ->> 'key' = 'relationship' then e := 'x.type_sort';
    elsif c ->> 'key' = 'parent' then e := $s$nullif(public.fx_norm(x.parent_name), '')$s$;
    elsif c ->> 'key' = 'account_manager' then e := $s$nullif(public.fx_norm((select concat_ws(' ', pr.first_name, pr.last_name) from public.company_assignees a join public.profiles pr on pr.id = a.profile_id where a.company_id = c.id and a.is_manager limit 1)), '')$s$;
    elsif c ->> 'key' = 'created_by' then e := $s$nullif(public.fx_norm((select concat_ws(' ', pr.first_name, pr.last_name) from public.profiles pr where pr.id = c.created_by)), '')$s$;
    else
      e := public.companies_fx(c ->> 'key', ty, p_ctx);
      if e is null then continue; end if;
      if ty = 'multi' then e := format('nullif(public.fx_norm(array_to_string(%s, %L)), %L)', e, ', ', '');
      elsif ty = 'number' then e := format('(%s)', e);
      elsif ty = 'boolean' then e := format('(case when coalesce(%s, false) then 1 else 0 end)', e);
      elsif ty = 'date' then e := format('(%s)', e);
      else e := format('nullif(public.fx_norm((%s)::text), %L)', e, '');
      end if;
    end if;
    ords := ords || format('%s %s nulls last', e, dir);
  end loop;
  o := array_to_string(ords || array['x.name_sort asc', 'c.id asc'], ', ');
end $function$;

create or replace function public.contacts_view_sql(p_view jsonb, p_search text, p_ctx jsonb, OUT w text, OUT o text)
 RETURNS record
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare c jsonb; e text; s text; parts text[] := '{}'; ords text[] := '{}'; q text := btrim(public.fx_norm(p_search)); ty text; dir text;
begin
  for c in select * from jsonb_array_elements(case when jsonb_typeof(p_view -> 'conds') = 'array' then p_view -> 'conds' else '[]'::jsonb end) loop
    ty := coalesce(c ->> 'type', 'text');
    if ty = 'phase' then                                                    -- 148: entered a deal phase
      s := public.phase_cond_sql('contact', c);
      if s is not null then parts := parts || ('(' || s || ')'); end if;
      continue;
    end if;
    e := public.contacts_fx(c ->> 'field', ty, p_ctx);
    if e is null then continue; end if;
    s := public.list_cond_sql(e, ty, c);
    if s is not null then parts := parts || ('(' || s || ')'); end if;
  end loop;
  w := case when cardinality(parts) = 0 then 'true'
            when p_view ->> 'match' = 'any' then '(' || array_to_string(parts, ' or ') || ')'
            else array_to_string(parts, ' and ') end;
  -- LIKE (not strpos) so the trigram index on search is used
  if q <> '' then w := w || format(' and x.search like %L', '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'); end if;

  for c in select * from jsonb_array_elements(case when jsonb_typeof(p_view -> 'sort') = 'array' then p_view -> 'sort' else '[]'::jsonb end) loop
    dir := case when c ->> 'dir' = 'desc' then 'desc' else 'asc' end;
    ty := coalesce(c ->> 'type', 'text');
    if ty = 'phase' then continue; end if;
    if c ->> 'key' = 'name' then e := 'x.name_sort';
    elsif c ->> 'key' = 'co_type' then e := 'x.type_sort';
    elsif c ->> 'key' = 'companies' then e := $s$nullif(public.fx_norm(array_to_string(x.company_names, ', ')), '')$s$;
    else
      e := public.contacts_fx(c ->> 'key', ty, p_ctx);
      if e is null then continue; end if;
      if ty = 'multi' then e := format('nullif(public.fx_norm(array_to_string(%s, %L)), %L)', e, ', ', '');
      elsif ty in ('number') then e := format('(%s)', e);
      elsif ty = 'boolean' then e := format('(case when coalesce(%s, false) then 1 else 0 end)', e);
      elsif ty = 'date' then e := format('(%s)', e);
      else e := format('nullif(public.fx_norm((%s)::text), %L)', e, '');
      end if;
    end if;
    ords := ords || format('%s %s nulls last', e, dir);
  end loop;
  o := array_to_string(ords || array['x.name_sort asc', 'c.id asc'], ', ');
end $function$;

create or replace function public.deal_phase_index()
returns jsonb language sql stable set search_path to 'public' as $$
  with ph as (
    select id, (row_number() over (order by id)) - 1 as i from public.pipeline_phases where tenant_id = public.current_tenant()
  ), ev as (
    select e.tracking_id, jsonb_agg(jsonb_build_array(ph.i, to_char((e.entered_at at time zone 'UTC')::date, 'YYYY-MM-DD')) order by e.entered_at) as list
    from public.tracking_phase_events e join ph on ph.id = e.phase_id
    where e.tenant_id = public.current_tenant()
    group by e.tracking_id
  ), ct as (
    select tracking_id, jsonb_agg(contact_id) as ids from public.tracking_contacts where tenant_id = public.current_tenant() group by tracking_id
  )
  select jsonb_build_object(
    'phases', coalesce((select jsonb_agg(id order by i) from ph), '[]'::jsonb),
    'deals', coalesce((select jsonb_agg(jsonb_build_array(t.id, t.company_id, coalesce(ct.ids, '[]'::jsonb), coalesce(ev.list, '[]'::jsonb)))
                       from public.trackings t left join ev on ev.tracking_id = t.id left join ct on ct.tracking_id = t.id
                       where t.tenant_id = public.current_tenant()), '[]'::jsonb));
$$;
grant execute on function public.deal_phase_index() to authenticated;
grant execute on function public.phase_cond_sql(text, jsonb) to authenticated;
