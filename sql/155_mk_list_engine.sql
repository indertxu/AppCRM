-- =====================================================================
-- 155 · Marketing › dynamic lists worked out on the SERVER (the list engine, in SQL)
--
-- A dynamic list is a set of rules (marketing_lists.definition). Until now only the app could
-- work out who is in one (MkEngine in ContactExport.tsx + exportCatalog.ts). This is the same
-- engine in the database, rule for rule, so a list is known at any moment without a browser:
--
--   mk_list_ids(tenant, entity, definition)    → the records the rules pick (contacts or companies)
--   mk_list_people(tenant, entity, definition) → the people who'd get an e-mail (a company list
--                                                brings its contacts, "all" or "one" per company;
--                                                no / invalid e-mail, unsubscribed and doubles out)
--
-- Every field the app offers works: the record's own columns (found from the table, kinds
-- inferred from the data like the app does), jsonb inner keys, custom fields (multiple choice
-- split like customList), Full name, E-mail domain, client / assignees / counts, companies and
-- deals around it (the deal scope "direct" / "company"), deal owner / team / products / phase
-- history / "Entered phase … since …", the deal's value (the same line maths as the app:
-- calculators, tiers, quantities, terms, yearly increases, discounts, partner cuts, the team's
-- revenue view), last contacted / by how / days since / last campaign e-mail. Operators,
-- "same company / same deal" grouping, groups with all / any, periods ("this month"…, in
-- Madrid time like the app) — as in condPasses / contactMatches / condReady.
--
-- Workflows › "Joins a list" with a dynamic list (154) now run here: every 5 minutes (pg_cron
-- 'marketing-dynamic-lists') each dynamic list that starts an active workflow is worked out and
-- whoever came in starts it (again when they come back). No browser needed.
--   mk_dyn_sync_now(list)  — the app asks right away (a list saved, a workflow switched on)
--   mk_list_check(list, ids[]) — the app's own result vs the server's, kept in mk_list_parity
--                                (so any difference shows up and can be fixed)
-- mk_sync_dynamic_list (154, the browser's people) now just asks the server.
-- Nothing is dropped or renamed. Safe to run twice. Needs 154.
-- =====================================================================

/* ---------------------------------------------------------------------
   1 · values the way JavaScript sees them
   --------------------------------------------------------------------- */
-- a field's values, one level of arrays opened (JS: Array.isArray(v) ? v : [v])
create or replace function public.mk_flat(j jsonb) returns setof jsonb
language sql immutable as $$
  select e from jsonb_array_elements(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) e
  union all
  select j where j is not null and jsonb_typeof(j) <> 'array'
$$;

-- isEmpty: null, "", []
create or replace function public.mk_filled(v jsonb) returns boolean
language sql immutable as $$
  select v is not null and v <> 'null'::jsonb and v <> '""'::jsonb and v <> '[]'::jsonb
$$;

-- String(v)
create or replace function public.mk_str(v jsonb) returns text
language sql immutable as $$
  select case jsonb_typeof(v)
    when 'string' then v #>> '{}'
    when 'number' then trim_scale((v #>> '{}')::numeric)::text
    when 'boolean' then v #>> '{}'
    when 'null' then 'null'
    when 'object' then '[object Object]'
    when 'array' then (select coalesce(string_agg(case when jsonb_typeof(e) = 'null' then '' else public.mk_str(e) end, ',' order by o), '')
                         from jsonb_array_elements(v) with ordinality x(e, o))
    else null end
$$;

-- Number(text): null = NaN
create or replace function public.mk_numtext(s text) returns float8
language plpgsql immutable as $$
declare t text := regexp_replace(coalesce(s, ''), '^[\s\u00a0\ufeff]+|[\s\u00a0\ufeff]+$', '', 'g');
begin
  if s is null then return 0; end if;
  if t = '' then return 0; end if;
  if t ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then
    begin return t::float8; exception when others then return null; end;
  end if;
  if t ~* '^0x[0-9a-f]+$' then
    begin return ('x' || lpad(substr(t, 3), 16, '0'))::bit(64)::bigint::float8; exception when others then return null; end;
  end if;
  if t ~ '^[+]?Infinity$' then return 'Infinity'::float8; end if;
  if t = '-Infinity' then return '-Infinity'::float8; end if;
  return null;
end $$;

-- Number(v): null = NaN
create or replace function public.mk_num(v jsonb) returns float8
language sql immutable as $$
  select case jsonb_typeof(v)
    when 'number' then (v #>> '{}')::float8
    when 'boolean' then case when v = 'true'::jsonb then 1 else 0 end
    when 'string' then public.mk_numtext(v #>> '{}')
    when 'null' then 0
    when 'array' then public.mk_numtext(public.mk_str(v))
    else null end
$$;
-- Number(x) || 0
create or replace function public.mk_num0(v jsonb) returns float8
language sql immutable as $$ select coalesce(nullif(public.mk_num(v), 'NaN'::float8), 0) $$;

-- norm(): NFD, accents out, lower case, trimmed
create or replace function public.mk_norm(t text) returns text
language sql immutable as $$
  select regexp_replace(lower(regexp_replace(normalize(coalesce(t, ''), NFD), '[\u0300-\u036f]', '', 'g')), '^[\s\u00a0\ufeff]+|[\s\u00a0\ufeff]+$', '', 'g')
$$;

-- customList(): a multiple-choice value as a list (older single values split on ; or ,)
create or replace function public.mk_custom_list(v jsonb) returns jsonb
language sql immutable as $$
  select case
    when v is null or v = 'null'::jsonb or v = '""'::jsonb then '[]'::jsonb
    when jsonb_typeof(v) = 'array' then coalesce((select jsonb_agg(to_jsonb(public.mk_str(e)) order by o)
                                                   from jsonb_array_elements(v) with ordinality x(e, o)
                                                  where btrim(public.mk_str(e)) <> ''), '[]'::jsonb)
    else coalesce((select jsonb_agg(to_jsonb(p) order by o) from unnest(regexp_split_to_array(public.mk_str(v), '\s*[;,]\s*')) with ordinality x(p, o) where p <> ''), '[]'::jsonb)
  end
$$;

-- JS Math.round(x * 100) / 100
create or replace function public.mk_round2(x float8) returns float8
language sql immutable as $$ select floor(x * 100 + 0.5) / 100 $$;

-- an ISO timestamp the way toISOString() writes it
create or replace function public.mk_iso(t timestamptz) returns text
language sql immutable as $$ select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

/* ---------------------------------------------------------------------
   2 · periods (resolvePeriod / inPeriod), today in Madrid like the app
   --------------------------------------------------------------------- */
create or replace function public.mk_period(p_key text, out lo text, out hi text)
language plpgsql stable as $$
declare d date := (now() at time zone 'Europe/Madrid')::date; wd int; q date; m date;
begin
  wd := (extract(isodow from d)::int - 1);           -- Monday = 0
  m := date_trunc('month', d)::date;
  q := (date_trunc('quarter', d))::date;
  case p_key
    when 'today' then lo := d; hi := d;
    when 'past' then lo := null; hi := d - 1;
    when 'future' then lo := d; hi := null;
    when 'this_week' then lo := d - wd; hi := d - wd + 6;
    when 'last_week' then lo := d - wd - 7; hi := d - wd - 1;
    when 'next_week' then lo := d - wd + 7; hi := d - wd + 13;
    when 'this_month' then lo := m; hi := (m + interval '1 month')::date - 1;
    when 'last_month' then lo := (m - interval '1 month')::date; hi := m - 1;
    when 'next_month' then lo := (m + interval '1 month')::date; hi := (m + interval '2 month')::date - 1;
    when 'this_quarter' then lo := q; hi := (q + interval '3 month')::date - 1;
    when 'last_quarter' then lo := (q - interval '3 month')::date; hi := q - 1;
    when 'next_quarter' then lo := (q + interval '3 month')::date; hi := (q + interval '6 month')::date - 1;
    when 'this_year', 'report' then lo := make_date(extract(year from d)::int, 1, 1); hi := make_date(extract(year from d)::int, 12, 31);
    when 'last_year' then lo := make_date(extract(year from d)::int - 1, 1, 1); hi := make_date(extract(year from d)::int - 1, 12, 31);
    when 'next_year' then lo := make_date(extract(year from d)::int + 1, 1, 1); hi := make_date(extract(year from d)::int + 1, 12, 31);
    when 'ytd' then lo := make_date(extract(year from d)::int, 1, 1); hi := d;
    when 'last_30' then lo := d - 30; hi := d;
    when 'last_90' then lo := d - 90; hi := d;
    when 'next_30' then lo := d; hi := d + 30;
    when 'next_90' then lo := d; hi := d + 90;
    else lo := null; hi := null;                        -- custom (no dates here) / unknown: any date
  end case;
end $$;

create or replace function public.mk_in_period(p_date text, p_key text) returns boolean
language plpgsql stable as $$
declare r record; v text;
begin
  if p_key = 'all' then return true; end if;
  if p_date is null or p_date = '' then return false; end if;
  v := left(p_date, 10);
  select * into r from public.mk_period(p_key);
  return (r.lo is null or v >= r.lo) and (r.hi is null or v <= r.hi);
end $$;

/* ---------------------------------------------------------------------
   3 · a deal's value ("Value (total if won)") — potentialTotalsFromRows / lineBreakdown
       (salesApi.ts, catalogApi.ts), in doubles like JavaScript
   --------------------------------------------------------------------- */
-- discountOf(amount, d)
create or replace function public.mk_discount_of(p_amount float8, d jsonb) returns float8
language plpgsql immutable as $$
declare v float8; raw float8;
begin
  if d is null or d = 'null'::jsonb or jsonb_typeof(d) <> 'object' or d->>'mode' = 'none' then return 0; end if;
  v := public.mk_num0(d->'value');
  raw := case when d->>'mode' = 'percent' then p_amount * (v / 100) else v end;
  return least(greatest(raw, 0), greatest(p_amount, 0));
end $$;

-- yearlySchedule(first, years, mode, value)
create or replace function public.mk_yearly_schedule(p_first float8, p_years float8, p_mode text, p_value float8) returns float8[]
language plpgsql immutable as $$
declare n int := greatest(1, least(20, floor(coalesce(nullif(p_years, 0), 1) + 0.5)::int)); v float8 := coalesce(p_value, 0);
        cur float8 := coalesce(p_first, 0); o float8[] := '{}'; i int;
begin
  for i in 0 .. n - 1 loop
    if i > 0 then cur := case p_mode when 'percent' then cur * (1 + v / 100) when 'amount' then cur + v else cur end; end if;
    o := o || public.mk_round2(cur);
  end loop;
  return o;
end $$;

-- yearAmounts(firstYear, years, increments)
create or replace function public.mk_year_amounts(p_first float8, p_years float8, inc jsonb) returns float8[]
language plpgsql immutable as $$
declare y float8 := greatest(0, coalesce(p_years, 0)); n int; frac0 float8; o float8[] := '{}'; i int; prev float8; c jsonb; a float8; md text;
begin
  n := greatest(1, ceil(y - 1e-9)::int);
  frac0 := y - floor(y);
  md := case when inc is null or inc = 'null'::jsonb or jsonb_typeof(inc) <> 'object' then 'none' else coalesce(inc->>'mode', '') end;
  if md in ('none', 'pct', 'fixed') then
    o := public.mk_yearly_schedule(p_first, n, case md when 'pct' then 'percent' when 'fixed' then 'amount' else 'none' end,
                                   case when md = 'none' then 0 else public.mk_num0(inc->'value') end);
    if y > 0 and frac0 > 1e-9 then o[array_length(o, 1)] := public.mk_round2(o[array_length(o, 1)] * frac0); end if;
    return o;
  end if;
  for i in 0 .. n - 1 loop
    prev := case when i > 0 then o[i] else p_first end;
    c := case when i > 0 then inc->'perYear'->i else null end;
    a := case when c is not null and c <> 'null'::jsonb and c <> '""'::jsonb and public.mk_num(c) is not null and public.mk_num(c) not in ('Infinity'::float8, '-Infinity'::float8)
              then public.mk_num(c) else prev end;
    o := o || public.mk_round2(a);
  end loop;
  if y > 0 and frac0 > 1e-9 then o[n] := public.mk_round2(o[n] * frac0); end if;
  return o;
end $$;

-- calcBreakdown(calc, values, basePrice, discounts): the rows (key, amount, discount)
create or replace function public.mk_calc_rows(p_calc uuid, p_values jsonb, p_base float8, p_disc jsonb, p_roles jsonb default '{}'::jsonb)
returns table(k text, amount float8, discount float8, own float8)
language plpgsql stable set search_path = public as $$
declare c record; v record; key text; raw jsonb; val float8; amt float8; o jsonb; ad float8; inc float8; billable float8; sz float8; blocks float8; ov jsonb;
begin
  select * into c from public.calculators where id = p_calc;
  if not found then return; end if;
  if c.include_base then
    k := '__base'; amount := p_base; discount := public.mk_discount_of(p_base, p_disc->'__base'); own := null; return next;
  end if;
  for v in select * from public.calculator_variables where calculator_id = p_calc order by sort, created_at, id loop
    key := coalesce(v.id::text, v.sort::text);
    raw := p_values->key;
    val := case when raw is null or raw = 'null'::jsonb then coalesce(v.default_value::float8, 0) else public.mk_num0(raw) end;
    o := p_values->(key || '@price');
    amt := case when coalesce(v.price_editable, false) and o is not null and o <> 'null'::jsonb and public.mk_num(o) is not null
                     and public.mk_num(o) not in ('Infinity'::float8, '-Infinity'::float8)
                then greatest(0, public.mk_num(o)) else coalesce(v.amount::float8, 0) end;
    if v.var_type = 'fixed' then
      if val = 0 then continue; end if;
      ad := amt;
    elsif v.var_type = 'percent' then
      ad := p_base * (amt / 100);
    else
      inc := coalesce(v.included::float8, 0);
      billable := greatest(0, val - inc);
      if billable <= 0 then continue; end if;
      if v.var_type = 'per_unit' then
        ad := billable * amt;
      else
        sz := coalesce(nullif(v.block_size::float8, 0), 1);
        blocks := case when v.round_mode = 'down' then floor(billable / sz) else ceil(billable / sz) end;
        if blocks <= 0 then continue; end if;
        ad := blocks * amt;
      end if;
    end if;
    ov := p_values->(key || '@days');
    if c.output_kind = 'quantity' and ov is not null and ov <> 'null'::jsonb then ad := greatest(0, public.mk_num0(ov)); end if;
    k := key; amount := ad; discount := public.mk_discount_of(ad, p_disc->key);
    -- a variable's own rate (services: or its role's price)
    own := case when v.rate is not null then v.rate::float8
                when v.role_id is not null and p_roles ? v.role_id::text then public.mk_num0(p_roles->v.role_id::text) else null end;
    return next;
  end loop;
end $$;

-- one line's revenue in the team's view (lineBreakdown + lineRevenue)
create or replace function public.mk_line_value(p_kind text, l jsonb, p_calc uuid, p_base float8, p_min float8, p_mode text, p_roles jsonb)
returns float8 language plpgsql stable set search_path = public as $$
declare
  c record; has_calc boolean := false;
  vals jsonb := case when jsonb_typeof(l->'calc_values') = 'object' then l->'calc_values' else '{}'::jsonb end;
  disc jsonb := case when jsonb_typeof(l->'calc_discounts') = 'object' then l->'calc_discounts' else '{}'::jsonb end;
  rates jsonb := case when jsonb_typeof(l->'calc_rates') = 'object' then l->'calc_rates' else '{}'::jsonb end;
  unit_net float8 := 0; r record; rate float8; a float8; d float8; g float8 := 0; ds float8 := 0;
  base float8; legacy jsonb; raw_qty float8; qty float8; m float8; mult float8; per_year float8; yrs float8;
  sched float8[]; total float8; per float8[]; part float8[] := '{}'; pv float8; pp jsonb; i int; n int; on_ boolean; amt float8;
  net float8; skip jsonb;
begin
  if p_calc is not null then select * into c from public.calculators where id = p_calc; has_calc := found; end if;
  -- unitBreakdown
  if has_calc and c.output_kind = 'quantity' then
    for r in select * from public.mk_calc_rows(p_calc, vals, coalesce(c.base_amount::float8, 0), '{}'::jsonb, coalesce(p_roles, '{}'::jsonb)) loop
      rate := case when rates ? r.k and rates->r.k <> 'null'::jsonb then public.mk_num0(rates->r.k)
                   else coalesce(r.own, public.mk_num0(l->'price')) end;
      a := r.amount * rate;
      d := public.mk_discount_of(a, disc->r.k);
      g := g + a; ds := ds + d;
    end loop;
    unit_net := g - ds;
  elsif has_calc then
    base := case when public.mk_num0(l->'price') > 0 then public.mk_num0(l->'price') else coalesce(p_base, 0) end;
    select coalesce(sum(x.amount), 0), coalesce(sum(x.discount), 0) into g, ds from public.mk_calc_rows(p_calc, vals, base, disc) x;
    unit_net := g - ds;
  else
    a := public.mk_num0(l->'price');
    legacy := case when disc ? '__base' and disc->'__base' <> 'null'::jsonb then disc->'__base'
                   when coalesce(l->>'discount_mode', '') not in ('', 'none') then jsonb_build_object('mode', l->>'discount_mode', 'value', public.mk_num0(l->'discount_value'))
                   else null end;
    unit_net := a - public.mk_discount_of(a, legacy);
  end if;
  -- quantity, term
  raw_qty := case when l->'quantity' is null or l->'quantity' = 'null'::jsonb then 1 else public.mk_num0(l->'quantity') end;
  m := coalesce(p_min, 0);
  qty := case when m <= 0 then raw_qty else round((ceil(raw_qty / m) * m)::numeric, 4)::float8 end;
  sched := null;
  if coalesce((l->>'recurring')::boolean, false) then
    per_year := case when l->>'period' = 'monthly' then 12 else 1 end;
    yrs := case when l->'term_years' is null or l->'term_years' = 'null'::jsonb then 1 else public.mk_num0(l->'term_years') end;
    mult := per_year * yrs;
    if yrs > 0 then sched := public.mk_year_amounts(unit_net * per_year, yrs, l->'increments'); end if;
  elsif has_calc and c.output_kind = 'quantity' then
    mult := 1;
  else
    mult := qty;
  end if;
  total := case when sched is not null then (select coalesce(sum(x), 0) from unnest(sched) x) else unit_net * mult end;
  -- partnerByPeriod
  per := case when sched is not null and cardinality(sched) > 0 then sched else array[total] end;
  n := cardinality(per);
  pv := public.mk_num0(l->'partner_value');
  pp := case when l->'partner_periods' is null or l->'partner_periods' = 'null'::jsonb then null else l->'partner_periods' end;
  if coalesce(l->>'partner_id', '') = '' or pv = 0 or total = 0 then
    part := array_fill(0::float8, array[n]);
  elsif pp is null and l->>'partner_mode' = 'amount' then
    part := array_fill(0::float8, array[n]); part[1] := least(pv, total);
  else
    skip := case when jsonb_typeof(pp->'skip') = 'array' then pp->'skip' else '[]'::jsonb end;
    for i in 1 .. n loop
      on_ := case when pp is null then (case when l->>'partner_mode' = 'amount' then i = 1 else true end)
                  when pp->>'mode' = 'once' then i = 1
                  else not exists (select 1 from jsonb_array_elements(skip) s where s = to_jsonb(i - 1)) end;
      amt := per[i];
      part := part || (case when not on_ then 0
                            when l->>'partner_mode' = 'amount' then least(pv, amt)
                            else floor(amt * least(pv, 100) + 0.5) / 100 end);
    end loop;
  end if;
  net := total - (select coalesce(sum(x), 0) from unnest(part) x);
  -- lineRevenue
  if p_kind = 'service' then return case when p_mode in ('all_year1', 'all_term') then net else 0 end; end if;
  if p_mode in ('product_term', 'all_term') then return net; end if;
  return coalesce(per[1], total) - coalesce(part[1], 0);
end $$;

-- every deal's value for a company (the team's revenue view, deal_settings.revenue_mode)
create or replace function public.mk_deal_values(p_tenant uuid) returns table(id uuid, v float8)
language plpgsql stable set search_path = public as $$
declare md text;
begin
  select ds.revenue_mode into md from public.deal_settings ds where ds.tenant_id = p_tenant order by ds.updated_at desc nulls last limit 1;
  if md is null or md not in ('product_year1', 'product_term', 'all_year1', 'all_term') then md := 'product_year1'; end if;
  return query
  with pl as (
    select tp.tracking_id, public.mk_line_value('product', to_jsonb(tp),
             (select ca.id from public.calculators ca where ca.owner_type = 'product' and ca.owner_id = pr.id order by ca.created_at desc limit 1),
             (select pt.price::float8 from public.product_tiers pt where pt.id = tp.tier_id and pt.product_id = pr.id),
             null, md, '{}'::jsonb) as val
      from public.tracking_products tp
      left join public.products pr on pr.id = tp.product_id and pr.tenant_id = p_tenant
     where tp.tenant_id = p_tenant and tp.tracking_id is not null and tp.version_active is distinct from false
  ), sl as (
    select ts.tracking_id, public.mk_line_value('service', to_jsonb(ts),
             (select ca.id from public.calculators ca where ca.owner_type = 'service' and ca.owner_id = sv.id order by ca.created_at desc limit 1),
             null,
             coalesce(sv.min_unit::float8, case when sv.rate_unit = 'hour' then 0.5 else 0.25 end),
             md,
             coalesce((select jsonb_object_agg(x.role_id::text, x.price) from (
                        select distinct on (sr.role_id) sr.role_id, sr.price from public.service_roles sr
                         where sr.service_id = sv.id and sr.role_id is not null order by sr.role_id, sr.sort, sr.created_at) x), '{}'::jsonb)) as val
      from public.tracking_potential_services ts
      left join public.services sv on sv.id = ts.service_id and sv.tenant_id = p_tenant
     where ts.tenant_id = p_tenant and ts.tracking_id is not null and ts.version_active is distinct from false
  ), legacy as (
    select t.id as tracking_id, t.product_price::float8 as val
      from public.trackings t
     where t.tenant_id = p_tenant and coalesce(t.product_price, 0) <> 0
       and not exists (select 1 from public.tracking_products tp where tp.tracking_id = t.id and tp.version_active is distinct from false)
  )
  select x.tracking_id, public.mk_round2(sum(x.val))
    from (select * from pl union all select * from sl union all select * from legacy) x
   group by x.tracking_id;
end $$;

/* ---------------------------------------------------------------------
   4 · when we were last in touch (loadLastTouch): meetings and linked calendar blocks,
       e-mails in the synced mailboxes, contacts logged on a client; campaign e-mails apart
       k = 'contact' | 'company' | 'campaign'
   --------------------------------------------------------------------- */
create or replace function public.mk_touch(p_tenant uuid) returns table(k text, id uuid, at timestamptz, how text)
language sql stable set search_path = public as $$
  with
  ct as (
    select c.id, lower(btrim(coalesce(c.email, ''))) as em,
           public.mk_norm(concat_ws(' ', nullif(c.first_name, ''), nullif(c.last_name, ''))) as nm,
           row_number() over (order by c.id) as o
      from public.contacts c where c.tenant_id = p_tenant
  ),
  bymail as (select distinct on (em) em, id from ct where em <> '' order by em, o),
  ce as (
    select e.id, e.kind, e.company_id, e.contact_id, e.tracking_id,
           ((e.entry_date::timestamp + make_interval(mins => coalesce(e.start_min, 0))) at time zone 'Europe/Madrid') as at
      from public.calendar_entries e
     where e.tenant_id = p_tenant and e.entry_date is not null
       and (e.company_id is not null or e.contact_id is not null or e.tracking_id is not null)
  ),
  -- (who, when, how, order): contacts first; each one also touches its companies
  ev_contact as (
    select ce.contact_id as cid, ce.at, case when ce.kind = 'meeting' then 'meeting' else 'call / follow-up' end as how, 1 as src, ce.id::text as o
      from ce where ce.contact_id is not null
    union all
    select mc.contact_id, ce.at, 'meeting', 2, mc.meeting_id::text || mc.contact_id::text
      from public.meeting_contacts mc join ce on ce.id = mc.meeting_id
     where mc.tenant_id = p_tenant and mc.contact_id is not null
    union all
    select bm.id, m.received_at, 'e-mail', 3, m.id::text
      from public.ticket_mail_messages m join bymail bm on bm.em = lower(btrim(coalesce(m.from_email, '')))
     where m.tenant_id = p_tenant and m.direction = 'in'
    union all
    select bm.id, m.received_at, 'e-mail', 3, m.id::text
      from public.ticket_mail_messages m
      cross join lateral jsonb_array_elements(case when jsonb_typeof(m.to_recipients) = 'array' then m.to_recipients else '[]'::jsonb end) r
      join bymail bm on bm.em = lower(btrim(coalesce(case when jsonb_typeof(r) = 'object' then r->>'email' else r #>> '{}' end, '')))
     where m.tenant_id = p_tenant and coalesce(m.direction, '') <> 'in'
  ),
  logs as (
    select l.id, l.contacted_at as at, coalesce(nullif(lower(coalesce(l.channel, '')), ''), 'logged contact') as how, cl.company_id as co,
           public.mk_norm(l.contact_name) as nm
      from public.client_contacts_log l left join public.clients cl on cl.id = l.client_id
     where l.tenant_id = p_tenant
  ),
  -- a logged contact is the person with that name: the first one at the client's company, else the only one with that name
  -- (joins on the name, not a scan of every contact per log: thousands of logs x thousands of contacts)
  log_first as (
    select distinct on (lg.id) lg.id, c.id as cid
      from logs lg join ct c on c.nm = lg.nm
     where lg.nm <> ''
       and (lg.co is null or exists (select 1 from public.company_contacts cc where cc.contact_id = c.id and cc.company_id = lg.co))
     order by lg.id, c.o
  ),
  name_once as (select c.nm, min(c.id::text)::uuid as id from ct c where c.nm <> '' group by c.nm having count(*) = 1),
  log_contact as (
    select lg.at, lg.how, lg.id, coalesce(lf.cid, nmo.id) as cid
      from logs lg
      left join log_first lf on lf.id = lg.id
      left join name_once nmo on nmo.nm = lg.nm
  ),
  ev_contact_all as (
    select cid, at, how, src, o from ev_contact
    union all
    select cid, at, how, 4, id::text from log_contact where cid is not null
  ),
  ev_company as (
    -- a contact's touch reaches its companies (not the logged ones: those go to the client's company)
    select cc.company_id as coid, e.at, e.how, e.src, e.o
      from ev_contact e join public.company_contacts cc on cc.contact_id = e.cid
    union all
    select ce.company_id, ce.at, case when ce.kind = 'meeting' then 'meeting' else 'call / follow-up' end, 1, ce.id::text || 'b'
      from ce where ce.company_id is not null
    union all
    select t.company_id, ce.at, 'meeting', 1, ce.id::text || 'c'
      from ce join public.trackings t on t.id = ce.tracking_id
     where ce.kind = 'meeting' and t.company_id is not null
    union all
    select lg.co, lg.at, lg.how, 4, lg.id::text from logs lg where lg.co is not null
  )
  (select distinct on (x.cid) 'contact'::text, x.cid, x.at, x.how
     from ev_contact_all x where x.at is not null and x.at <= now() + interval '60 seconds'
    order by x.cid, date_trunc('milliseconds', x.at) desc, x.src, x.o)
  union all
  (select distinct on (y.coid) 'company'::text, y.coid, y.at, y.how
     from ev_company y where y.at is not null and y.at <= now() + interval '60 seconds'
    order by y.coid, date_trunc('milliseconds', y.at) desc, y.src, y.o)
  union all
  (select 'campaign'::text, s.contact_id, max(s.sent_at), null::text
     from public.marketing_sends s
    where s.tenant_id = p_tenant and s.status = 'sent' and s.contact_id is not null and s.sent_at is not null
    group by s.contact_id)
$$;

/* ---------------------------------------------------------------------
   5 · the fields (buildCatalog): what each key means, as SQL on one record
   --------------------------------------------------------------------- */
create or replace function public.mk_lx_table(p_src text) returns text
language sql immutable as $$ select case p_src when 'contact' then 'contacts' when 'company' then 'companies' when 'deal' then 'trackings' end $$;

-- the records of kind p_src around the row r (its companies / contacts / deals), as a FROM item
create or replace function public.mk_lx_set(p_root text, p_src text, p_scope text, p_tenant uuid) returns text
language plpgsql immutable as $$
declare t text := quote_literal(p_tenant::text) || '::uuid';
begin
  if p_root = 'contact' and p_src = 'company' then
    return format('(select co.* from public.companies co where co.tenant_id = %s and co.id in (select cc.company_id from public.company_contacts cc where cc.contact_id = r.id))', t);
  elsif p_root = 'contact' and p_src = 'deal' then
    return format('(select t.* from public.trackings t where t.tenant_id = %s and (t.id in (select tc.tracking_id from public.tracking_contacts tc where tc.contact_id = r.id)%s))', t,
      case when p_scope = 'company' then ' or t.company_id in (select cc.company_id from public.company_contacts cc where cc.contact_id = r.id)' else '' end);
  elsif p_root = 'company' and p_src = 'contact' then
    return format('(select ct.* from public.contacts ct where ct.tenant_id = %s and ct.id in (select cc.contact_id from public.company_contacts cc where cc.company_id = r.id))', t);
  elsif p_root = 'company' and p_src = 'deal' then
    return format('(select t.* from public.trackings t where t.tenant_id = %s and (t.company_id = r.id%s))', t,
      case when p_scope = 'company' then ' or t.id in (select tc.tracking_id from public.tracking_contacts tc where tc.contact_id in (select cc.contact_id from public.company_contacts cc where cc.company_id = r.id))' else '' end);
  end if;
  return null;
end $$;

-- infer(): what kind of values a discovered column holds (text / number / date / bool / enum)
-- p_vals: a query giving one jsonb value v per record of the company
create or replace function public.mk_lx_infer(p_tenant uuid, p_key text, p_vals text) returns text
language plpgsql stable set search_path = public as $$
declare st record; t text := quote_literal(p_tenant::text) || '::uuid'; hit boolean := false;
begin
  execute format($q$
    with v as (select x.v from (%s) x where public.mk_filled(x.v)),
         f as (select e as v from v cross join lateral public.mk_flat(v.v) e)
    select (select count(*) from v) as n,
           (select bool_and(jsonb_typeof(v) = 'boolean') from v) as all_bool,
           (select count(*) from f) as nf,
           (select bool_and(jsonb_typeof(v) = 'string' and (v #>> '{}') ~* '^[0-9a-f-]{32,36}$') from f) as all_ids,
           (select bool_and(jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}') from f) as all_dates,
           (select bool_and(jsonb_typeof(v) = 'number' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') <> ''
                                 and public.mk_num(v) is not null and public.mk_num(v) not in ('Infinity'::float8, '-Infinity'::float8))) from f) as all_num,
           (select count(distinct public.mk_str(v)) from f) as nd,
           (select coalesce(bool_and(char_length(public.mk_str(v)) <= 60), true) from f) as short,
           (select coalesce(bool_or(jsonb_typeof(v) = 'string' and btrim(v #>> '{}') ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$|^(https?://|www\.)|^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$|^in/'), false) from f) as urlish
  $q$, p_vals) into st;
  if coalesce(st.n, 0) = 0 then return 'text'; end if;
  if st.all_bool then return 'bool'; end if;
  -- references to other records (shown as names) → a list to pick from
  if p_key ~* '(_id|_by|_ids)$' or coalesce(st.all_ids, false) then
    execute format($q$
      with f as (select public.mk_str(e) as s from (%1$s) x cross join lateral public.mk_flat(x.v) e where public.mk_filled(x.v)),
           n as (select count(*) as n from f),
           maps as (
             select 'imports' as m, id::text as id from public.import_batches where tenant_id = %2$s
             union all select 'phases', id::text from public.pipeline_phases where tenant_id = %2$s
             union all select 'pipelines', id::text from public.pipelines where tenant_id = %2$s
             union all select 'products', id::text from public.products where tenant_id = %2$s
             union all select 'companies', id::text from public.companies where tenant_id = %2$s
             union all select 'people', id::text from public.profiles where tenant_id = %2$s
             union all select 'contacts', id::text from public.contacts where tenant_id = %2$s)
      select exists (select 1 from (select maps.m, count(*) as h from f join maps on maps.id = f.s group by maps.m) z, n where z.h > 0 and z.h >= n.n * 0.6)
    $q$, p_vals, t) into hit;
    if hit then return 'enum'; end if;
  end if;
  if coalesce(st.all_dates, false) then return 'date'; end if;
  if p_key in ('first_name', 'last_name', 'email', 'phone', 'position', 'notes', 'name', 'legal_name', 'vat_number', 'reg_number',
               'website', 'street', 'addr_number', 'addr_details', 'postal_code', 'loss_details', 'linkedin') then return 'text'; end if;
  if p_key !~* 'phone|vat|postal|zip|iban|reg_number|tax|cif|nif|code|number$' and coalesce(st.all_num, false) then return 'number'; end if;
  if p_key in ('city', 'province', 'country', 'status', 'loss_reason', 'language', 'sector', 'source') then return 'enum'; end if;
  if st.urlish then return 'text'; end if;
  if st.nd <= 30 and st.nf >= st.nd * 2 and st.short then return 'enum'; end if;
  return 'text';
end $$;

/*
  One field for a list of kind p_root: { m: 'root' | 'ent' | 'phase', src, e: SQL with %1$s for the record's alias, k: kind,
  need: 'touch' | 'dv' | 'clc' } — null when the app wouldn't have this field (the condition is then ignored, like the app).
*/
create or replace function public.mk_lx_field(p_tenant uuid, p_root text, p_scope text, p_key text) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  src text := split_part(p_key, ':', 1); k text := substr(p_key, length(split_part(p_key, ':', 1)) + 2);
  tbl text; t text := quote_literal(p_tenant::text) || '::uuid'; e text; kind text; m text; need text := null;
  col text; inner_k text; ok boolean; typ text; def record; cid text; has_defs boolean;
begin
  if src not in ('contact', 'company', 'deal') or k = '' then return null; end if;
  tbl := public.mk_lx_table(src);
  m := case when src = p_root then 'root' else 'ent' end;

  /* ---- built-in fields ---- */
  if src = 'contact' and k = '@name' then e := 'to_jsonb(concat_ws('' '', nullif(%1$s.first_name, ''''), nullif(%1$s.last_name, '''')))'; kind := 'text';
  elsif src = 'contact' and k = '@domain' then e := 'to_jsonb(split_part(coalesce(%1$s.email, ''''), ''@'', 2))'; kind := 'text';
  elsif src = 'contact' and k = '@client' then e := 'to_jsonb(%1$s.id::text in (select clc.id from clc))'; kind := 'bool'; need := 'clc';
  elsif src = 'contact' and k = '@assigned' then e := 'coalesce((select jsonb_agg(a.profile_id::text) from public.contact_assignees a where a.contact_id = %1$s.id and a.profile_id is not null), ''[]''::jsonb)'; kind := 'enum';
  elsif src = 'contact' and k = '@ncompanies' then e := 'to_jsonb((select count(*) from public.company_contacts cc where cc.contact_id = %1$s.id))'; kind := 'number';
  elsif src = 'contact' and k = '@ndeals' then
    if p_root <> 'contact' then return null; end if;
    e := format('to_jsonb((select count(*) from %s d))', public.mk_lx_set('contact', 'deal', p_scope, p_tenant)); kind := 'number';
  elsif src = 'contact' and k = '@has' then
    if p_root <> 'company' then return null; end if;
    return jsonb_build_object('m', 'root', 'src', src, 'k', 'bool', 'e', format('to_jsonb(exists (select 1 from %s x))', public.mk_lx_set('company', 'contact', p_scope, p_tenant)));
  elsif src in ('contact', 'company') and k in ('@lastcontact', '@sincecontact', '@lasthow') then
    -- touch is one map {"<kind>:<id>": [at, how]} (a lookup per record, not a scan)
    e := format('(select case when x.v is null then null else %s end from (select tm.m -> (%L || '':'' || %%1$s.id::text) as v from touch tm) x)',
                case k when '@lastcontact' then 'to_jsonb(public.mk_iso((x.v->>0)::timestamptz))' when '@sincecontact' then 'to_jsonb(greatest(0, floor(extract(epoch from (now() - (x.v->>0)::timestamptz)) / 86400))::bigint)' else '(x.v->1)' end, src);
    kind := case k when '@lastcontact' then 'date' when '@sincecontact' then 'number' else 'enum' end; need := 'touch';
  elsif src = 'contact' and k in ('@lastcampaign', '@sincecampaign') then
    e := format('(select case when x.v is null then null else %s end from (select tm.m -> (''campaign:'' || %%1$s.id::text) as v from touch tm) x)',
                case k when '@lastcampaign' then '(x.v->0)' else 'to_jsonb(greatest(0, floor(extract(epoch from (now() - (x.v->>0)::timestamptz)) / 86400))::bigint)' end);
    kind := case k when '@lastcampaign' then 'date' else 'number' end; need := 'touch';
  elsif src = 'company' and k = '@which' then e := 'to_jsonb(%1$s.id::text)'; kind := 'enum';
  elsif src = 'company' and k = '@has' then
    if p_root <> 'contact' then return null; end if;
    return jsonb_build_object('m', 'root', 'src', src, 'k', 'bool', 'e', format('to_jsonb(exists (select 1 from %s x))', public.mk_lx_set('contact', 'company', p_scope, p_tenant)));
  elsif src = 'company' and k = '@ncontacts' then
    if p_root <> 'company' then return null; end if;
    e := format('to_jsonb((select count(*) from %s x))', public.mk_lx_set('company', 'contact', p_scope, p_tenant)); kind := 'number';
  elsif src = 'company' and k = '@ndeals' then
    if p_root <> 'company' then return null; end if;
    e := format('to_jsonb((select count(*) from %s x))', public.mk_lx_set('company', 'deal', p_scope, p_tenant)); kind := 'number';
  elsif src = 'company' and k = '@client' then e := format('to_jsonb(%%1$s.id in (select cl.company_id from public.clients cl where cl.tenant_id = %s and cl.company_id is not null))', t); kind := 'bool';
  elsif src = 'company' and k = '@hasdeal' then e := format('to_jsonb(exists (select 1 from public.trackings t2 where t2.tenant_id = %s and t2.company_id = %%1$s.id))', t); kind := 'bool';
  elsif src = 'company' and k = '@opendeal' then e := format('to_jsonb(exists (select 1 from public.trackings t2 where t2.tenant_id = %s and t2.company_id = %%1$s.id and t2.status = ''active''))', t); kind := 'bool';
  elsif src = 'company' and k = '@assigned' then e := 'coalesce((select jsonb_agg(a.profile_id::text) from public.company_assignees a where a.company_id = %1$s.id and a.profile_id is not null), ''[]''::jsonb)'; kind := 'enum';
  elsif src = 'deal' and k in ('@has', '@open') then
    return jsonb_build_object('m', 'root', 'src', src, 'k', 'bool',
      'e', format('to_jsonb(exists (select 1 from %s x%s))', public.mk_lx_set(p_root, 'deal', p_scope, p_tenant), case when k = '@open' then ' where x.status = ''active''' else '' end));
  elsif src = 'deal' and k = '@owner' then e := '(select to_jsonb(te.profile_id::text) from public.tracking_employees te where te.tracking_id = %1$s.id and te.is_owner and te.profile_id is not null order by te.id desc limit 1)'; kind := 'enum';
  elsif src = 'deal' and k = '@team' then e := 'coalesce((select jsonb_agg(te.profile_id::text) from public.tracking_employees te where te.tracking_id = %1$s.id and te.profile_id is not null), ''[]''::jsonb)'; kind := 'enum';
  elsif src = 'deal' and k = '@products' then
    e := 'coalesce((select jsonb_agg(distinct x.p) from (select tp.product_id::text as p from public.tracking_products tp where tp.tracking_id = %1$s.id and tp.product_id is not null union select %1$s.product_id::text where %1$s.product_id is not null) x), ''[]''::jsonb)'; kind := 'enum';
  elsif src = 'deal' and k = '@total' then
    e := 'coalesce((select dm.m -> %1$s.id::text from dv dm), to_jsonb(nullif(%1$s.product_price::float8, 0)))'; kind := 'number'; need := 'dv';
  elsif src = 'deal' and k = '@entered' then
    return jsonb_build_object('m', 'phase', 'src', src, 'k', 'phase');
  elsif src = 'deal' and k = '@history' then
    e := 'coalesce((select jsonb_agg(distinct x.p) from (select pe.phase_id::text as p from public.tracking_phase_events pe where pe.tracking_id = %1$s.id and pe.phase_id is not null union select %1$s.current_phase_id::text where %1$s.current_phase_id is not null) x), ''[]''::jsonb)'; kind := 'enum';
  elsif left(k, 1) = '@' then
    return null;

  /* ---- custom fields ---- */
  elsif left(k, 7) = 'custom:' then
    cid := substr(k, 8);
    if cid = '' then return null; end if;
    has_defs := src <> 'deal' or exists (select 1 from public.tracking_fields tf where tf.tenant_id = p_tenant);
    def := null;
    if has_defs then
      execute format('select type from public.%I where tenant_id = $1 and id::text = $2', case src when 'contact' then 'contact_fields' when 'company' then 'company_fields' else 'tracking_fields' end)
        into typ using p_tenant, cid;
    end if;
    if typ is not null then
      e := case when typ = 'multiselect' then format('public.mk_custom_list(%%1$s.custom -> %L)', cid) else format('(%%1$s.custom -> %L)', cid) end;
      kind := case when typ in ('select', 'multiselect') then 'enum' when typ = 'boolean' then 'bool' when typ = 'number' then 'number' when typ = 'date' then 'date' else 'text' end;
    else
      -- a custom value without a definition: a field only if some record has it
      execute format('select exists (select 1 from public.%I x where x.tenant_id = $1 and jsonb_typeof(x.custom) = ''object'' and x.custom ? $2)', tbl) into ok using p_tenant, cid;
      if not ok then return null; end if;
      e := format('(%%1$s.custom -> %L)', cid);
      kind := public.mk_lx_infer(p_tenant, cid, format('select (x.custom -> %L) as v from public.%I x where x.tenant_id = %s', cid, tbl, t));
    end if;

  /* ---- the table's own columns (and the inner keys of a jsonb object column) ---- */
  else
    col := split_part(k, '.', 1);
    inner_k := case when position('.' in k) > 0 then substr(k, length(col) + 2) else null end;
    if col in ('id', 'tenant_id', 'companyIds', 'contactIds', 'custom', 'reg_number') then return null; end if;
    select c.data_type into typ from information_schema.columns c where c.table_schema = 'public' and c.table_name = tbl and c.column_name = col;
    if typ is null then return null; end if;
    -- a column whose values are all objects is shown as its inner keys
    ok := false;
    if typ in ('jsonb', 'json') then
      execute format('select count(*) filter (where jsonb_typeof(x.%1$I::jsonb) = ''object'') > 0
                         and count(*) filter (where jsonb_typeof(x.%1$I::jsonb) = ''object'') = count(*) filter (where public.mk_filled(x.%1$I::jsonb))
                        from public.%2$I x where x.tenant_id = $1', col, tbl) into ok using p_tenant;
    end if;
    if inner_k is null then
      if ok then return null; end if;
      e := format('(to_jsonb(%%1$s) -> %L)', col);
      kind := public.mk_lx_infer(p_tenant, col, format('select (to_jsonb(x) -> %L) as v from public.%I x where x.tenant_id = %s', col, tbl, t));
    else
      if not ok then return null; end if;
      execute format('select exists (select 1 from public.%2$I x where x.tenant_id = $1 and jsonb_typeof(x.%1$I::jsonb) = ''object'' and x.%1$I::jsonb ? $2)', col, tbl) into ok using p_tenant, inner_k;
      if not ok then return null; end if;
      e := format('(to_jsonb(%%1$s) -> %L -> %L)', col, inner_k);
      kind := public.mk_lx_infer(p_tenant, inner_k, format('select (to_jsonb(x) -> %L -> %L) as v from public.%I x where x.tenant_id = %s', col, inner_k, tbl, t));
    end if;
  end if;

  return jsonb_build_object('m', m, 'src', src, 'k', kind, 'e', e, 'need', need);
end $$;

/* ---------------------------------------------------------------------
   6 · conditions (condPasses / condReady / contactMatches) and the list
   --------------------------------------------------------------------- */
-- one operator over a set of values (p_vals: a query giving column v)
create or replace function public.mk_lx_op(p_op text, p_a text, p_b text, p_list text[], p_kind text, p_vals text) returns text
language plpgsql stable as $$
declare a text := coalesce(p_a, ''); b text := coalesce(p_b, ''); na float8; nb float8;
        f text := format('select 1 from (%s) q where public.mk_filled(q.v)', p_vals);
begin
  case p_op
    when 'empty' then return format('not exists (%s)', f);
    when 'not_empty' then return format('exists (%s)', f);
    when 'yes' then return format('exists (select 1 from (%s) q where q.v = ''true''::jsonb)', p_vals);
    when 'no' then return format('not exists (select 1 from (%s) q where q.v = ''true''::jsonb)', p_vals);
    when 'contains' then
      if a = '' then return 'false'; end if;
      return format('exists (%s and strpos(public.mk_norm(public.mk_str(q.v)), %L) > 0)', f, public.mk_norm(a));
    when 'not_contains' then
      if a = '' then return 'true'; end if;
      return format('not exists (%s and strpos(public.mk_norm(public.mk_str(q.v)), %L) > 0)', f, public.mk_norm(a));
    when 'is' then return format('exists (%s and public.mk_norm(public.mk_str(q.v)) = %L)', f, public.mk_norm(a));
    when 'gte', 'lte' then
      if a = '' then return 'false'; end if;
      na := public.mk_numtext(a);
      if na is null or na = 'NaN'::float8 then return 'false'; end if;
      return format('exists (%s and public.mk_num(q.v) %s %L::float8)', f, case when p_op = 'gte' then '>=' else '<=' end, na::text);
    when 'any' then
      if coalesce(cardinality(p_list), 0) = 0 then return 'false'; end if;
      return format('exists (%s and public.mk_str(q.v) = any (%L::text[]))', f, p_list);
    when 'all' then
      if coalesce(cardinality(p_list), 0) = 0 then return 'false'; end if;
      return format('not exists (select 1 from unnest(%L::text[]) w(x) where not exists (%s and public.mk_str(q.v) = w.x))', p_list, f);
    when 'none' then
      if coalesce(cardinality(p_list), 0) = 0 then return 'true'; end if;
      return format('not exists (%s and public.mk_str(q.v) = any (%L::text[]))', f, p_list);
    when 'period' then
      if a = '' then return 'false'; end if;
      return format('exists (%s and public.mk_in_period(left(public.mk_str(q.v), 10), %L))', f, a);
    when 'between' then
      if p_kind = 'date' then
        return format('exists (%s%s%s)', f,
          case when a <> '' then format(' and left(public.mk_str(q.v), 10) >= %L', a) else '' end,
          case when b <> '' then format(' and left(public.mk_str(q.v), 10) <= %L', b) else '' end);
      end if;
      na := case when a = '' then null else coalesce(nullif(public.mk_numtext(a), 'NaN'::float8), 'NaN'::float8) end;
      nb := case when b = '' then null else coalesce(nullif(public.mk_numtext(b), 'NaN'::float8), 'NaN'::float8) end;
      if (a <> '' and na = 'NaN'::float8) or (b <> '' and nb = 'NaN'::float8) then return 'false'; end if;
      return format('exists (%s%s%s)', f,
        case when a <> '' then format(' and public.mk_num(q.v) >= %L::float8', na::text) else '' end,
        case when b <> '' then format(' and public.mk_num(q.v) <= %L::float8', nb::text) else '' end);
    else return 'true';
  end case;
end $$;

-- "Entered phase …" (phaseHitMatches) over the phase hits p, d of a set of deals (p_hits: query with columns p, d)
create or replace function public.mk_lx_phase(p_op text, p_list text[], p_a text, p_b text, p_hits text) returns text
language plpgsql stable as $$
declare l text := format('select h.d from (%s) h where h.p = any (%L::text[])', p_hits, coalesce(p_list, '{}'::text[]));
        a text := coalesce(p_a, ''); b text := coalesce(p_b, ''); w text;
begin
  if p_op = 'p_never' then return format('not exists (%s)', l); end if;
  w := case p_op
    when 'p_ever' then ''
    when 'p_since' then case when a = '' then '' else format(' and h.d >= %L', a) end
    when 'p_before' then case when a = '' then '' else format(' and h.d < %L', a) end
    when 'p_between' then case when a = '' then '' else format(' and h.d >= %L', a) end || case when b = '' then '' else format(' and h.d <= %L', b) end
    when 'p_last30' then ' and h.d >= to_char((now() at time zone ''UTC'')::date - 30, ''YYYY-MM-DD'')'
    when 'p_last90' then ' and h.d >= to_char((now() at time zone ''UTC'')::date - 90, ''YYYY-MM-DD'')'
    when 'p_year' then ' and h.d >= to_char(date_trunc(''year'', now() at time zone ''UTC''), ''YYYY-MM-DD'')'
    else '' end;
  return format('exists (%s%s)', l, w);
end $$;

-- is a condition finished (condReady)?
create or replace function public.mk_lx_ready(p_kind text, c jsonb) returns boolean
language sql immutable as $$
  select case
    when p_kind = 'phase' then jsonb_array_length(case when jsonb_typeof(c->'vals') = 'array' then c->'vals' else '[]'::jsonb end) > 0
      and case when c->>'op' in ('p_since', 'p_before') then coalesce(c->>'a', '') <> ''
               when c->>'op' = 'p_between' then coalesce(c->>'a', '') <> '' or coalesce(c->>'b', '') <> ''
               else true end
    when c->>'op' in ('empty', 'not_empty', 'yes', 'no') then true
    when p_kind = 'enum' then jsonb_array_length(case when jsonb_typeof(c->'vals') = 'array' then c->'vals' else '[]'::jsonb end) > 0
    when c->>'op' = 'between' then coalesce(c->>'a', '') <> '' or coalesce(c->>'b', '') <> ''
    else coalesce(c->>'a', '') <> '' end
$$;

-- the links between a row r of kind p_root and the records of kind p_src around it (root, ent)
create or replace function public.mk_lx_link(p_root text, p_src text, p_scope text) returns text
language sql immutable as $$
  select case
    when p_root = 'contact' and p_src = 'company' then 'select cc.contact_id as root, cc.company_id as ent from public.company_contacts cc'
    when p_root = 'contact' and p_src = 'deal' then 'select tc.contact_id as root, tc.tracking_id as ent from public.tracking_contacts tc'
      || case when p_scope = 'company' then ' union all select cc.contact_id, t.id from public.company_contacts cc join public.trackings t on t.company_id = cc.company_id' else '' end
    when p_root = 'company' and p_src = 'contact' then 'select cc.company_id as root, cc.contact_id as ent from public.company_contacts cc'
    when p_root = 'company' and p_src = 'deal' then 'select t.company_id as root, t.id as ent from public.trackings t where t.company_id is not null'
      || case when p_scope = 'company' then ' union all select cc.company_id, tc.tracking_id from public.company_contacts cc join public.tracking_contacts tc on tc.contact_id = cc.contact_id' else '' end
  end
$$;

-- "r has at least one company / deal / contact (around it) for which p_cond holds" (p_cond on alias e), worked out as a set
create or replace function public.mk_lx_has(p_tenant uuid, p_root text, p_src text, p_scope text, p_cond text) returns text
language plpgsql immutable as $$
begin
  if p_cond = 'false' then return 'false'; end if;
  return format('r.id in (select lk.root from (%s) lk where lk.root is not null and lk.ent in (select e.id from public.%I e where e.tenant_id = %s and (%s)))',
    public.mk_lx_link(p_root, p_src, p_scope), public.mk_lx_table(p_src), quote_literal(p_tenant::text) || '::uuid', p_cond);
end $$;

-- one condition on ONE record e of a related kind (company / deal / contact)
create or replace function public.mk_lx_one(fi jsonb, p_op text, c jsonb) returns text
language plpgsql stable as $$
declare lst text[] := array(select jsonb_array_elements_text(case when jsonb_typeof(c->'vals') = 'array' then c->'vals' else '[]'::jsonb end));
begin
  if fi->>'m' = 'phase' then
    return public.mk_lx_phase(p_op, lst, c->>'a', c->>'b',
      'select pe.phase_id::text as p, to_char((pe.entered_at at time zone ''UTC'')::date, ''YYYY-MM-DD'') as d from public.tracking_phase_events pe where pe.tracking_id = e.id');
  end if;
  return public.mk_lx_op(p_op, c->>'a', c->>'b', lst, fi->>'k', format('select f.v from public.mk_flat(%s) f(v)', format(fi->>'e', 'e')));
end $$;

/* the list's rules as one SQL condition on the row r (null = no finished rule: everyone) + the helpers it needs */
create or replace function public.mk_lx_compile(p_tenant uuid, p_entity text, p_def jsonb, out pred text, out needs text[])
language plpgsql stable set search_path = public as $$
declare
  root text := case when p_entity = 'companies' then 'company' else 'contact' end;
  scope text := coalesce(nullif(p_def->>'dealScope', ''), 'direct');
  gm text := coalesce(nullif(p_def->>'groupsMatch', ''), 'any');
  g jsonb; c jsonb; fi jsonb; fields jsonb := '{}'::jsonb; key text;
  parts text[]; gparts text[] := '{}'; srcs text[]; s text; inside text[];
  lst text[]; one text; op text; match text; w text; x text;
  active jsonb;
begin
  needs := '{}';
  for g in select y from jsonb_array_elements(case when jsonb_typeof(p_def->'groups') = 'array' then p_def->'groups' else '[]'::jsonb end) y loop
    match := coalesce(g->>'match', 'all');
    active := '[]'::jsonb;
    for c in select y from jsonb_array_elements(case when jsonb_typeof(g->'conds') = 'array' then g->'conds' else '[]'::jsonb end) y loop
      key := coalesce(c->>'field', '');
      if key = '' then continue; end if;
      if not fields ? key then fields := fields || jsonb_build_object(key, coalesce(public.mk_lx_field(p_tenant, root, scope, key), 'null'::jsonb)); end if;
      fi := fields->key;
      if fi is null or fi = 'null'::jsonb then continue; end if;
      if not public.mk_lx_ready(fi->>'k', c) then continue; end if;
      active := active || jsonb_build_array(jsonb_build_object('f', fi, 'c', c));
      if fi->>'need' is not null and not (fi->>'need' = any (needs)) then needs := needs || (fi->>'need'); end if;
    end loop;
    if jsonb_array_length(active) = 0 then continue; end if;

    parts := '{}'; srcs := '{}';
    for fi, c in select y->'f', y->'c' from jsonb_array_elements(active) y loop
      op := coalesce(c->>'op', '');
      lst := array(select jsonb_array_elements_text(case when jsonb_typeof(c->'vals') = 'array' then c->'vals' else '[]'::jsonb end));
      if fi->>'m' = 'root' then
        -- the row's own field
        parts := parts || public.mk_lx_op(op, c->>'a', c->>'b', lst, fi->>'k', format('select f.v from public.mk_flat(%s) f(v)', format(fi->>'e', 'r')));
      elsif match = 'all' and op not in ('none', 'empty', 'no', 'not_contains', 'p_never') then
        -- held for the same company / deal / contact: below, one per kind
        if not (fi->>'src' = any (srcs)) then srcs := srcs || (fi->>'src'); end if;
      elsif op = 'empty' then parts := parts || ('not ' || public.mk_lx_has(p_tenant, root, fi->>'src', scope, public.mk_lx_one(fi, 'not_empty', c)));
      elsif op = 'no' then parts := parts || ('not ' || public.mk_lx_has(p_tenant, root, fi->>'src', scope, public.mk_lx_one(fi, 'yes', c)));
      elsif op = 'not_contains' then
        parts := parts || (case when coalesce(c->>'a', '') = '' then 'true' else 'not ' || public.mk_lx_has(p_tenant, root, fi->>'src', scope, public.mk_lx_one(fi, 'contains', c)) end);
      elsif op = 'none' then
        parts := parts || (case when cardinality(lst) = 0 then 'true' else 'not ' || public.mk_lx_has(p_tenant, root, fi->>'src', scope, public.mk_lx_one(fi, 'any', c)) end);
      elsif op = 'p_never' then parts := parts || ('not ' || public.mk_lx_has(p_tenant, root, 'deal', scope, public.mk_lx_one(fi, 'p_ever', c)));
      elsif op = 'all' and fi->>'m' <> 'phase' then
        -- every value is found on one of them (not necessarily the same one)
        if cardinality(lst) = 0 then parts := parts || 'false'::text;
        else
          inside := '{}';
          foreach w in array lst loop
            inside := inside || public.mk_lx_has(p_tenant, root, fi->>'src', scope, public.mk_lx_one(fi, 'any', jsonb_set(c, '{vals}', jsonb_build_array(w))));
          end loop;
          parts := parts || ('(' || array_to_string(inside, ' and ') || ')');
        end if;
      else
        one := public.mk_lx_one(fi, op, c);
        parts := parts || (case when one = 'true' then 'true' else public.mk_lx_has(p_tenant, root, fi->>'src', scope, one) end);
      end if;
    end loop;
    -- "all": the positive conditions on companies (deals, contacts) hold for one and the same company (deal, contact)
    foreach s in array srcs loop
      inside := '{}';
      for fi, c in select y->'f', y->'c' from jsonb_array_elements(active) y
                    where y->'f'->>'src' = s and y->'f'->>'m' in ('ent', 'phase') and not (coalesce(y->'c'->>'op', '') in ('none', 'empty', 'no', 'not_contains', 'p_never')) loop
        x := public.mk_lx_one(fi, coalesce(c->>'op', ''), c);
        if x <> 'true' then inside := inside || x; end if;
      end loop;
      parts := parts || public.mk_lx_has(p_tenant, root, s, scope, case when cardinality(inside) = 0 then 'true' else array_to_string(inside, ' and ') end);
    end loop;
    gparts := gparts || ('(' || array_to_string(parts, case when match = 'any' then ' or ' else ' and ' end) || ')');
  end loop;
  if cardinality(gparts) = 0 then pred := null; return; end if;
  pred := array_to_string(gparts, case when gm = 'all' then ' and ' else ' or ' end);
end $$;

-- the helpers a compiled rule set may need, as a WITH list
create or replace function public.mk_lx_with(p_tenant uuid, p_needs text[]) returns text
language plpgsql immutable as $$
declare w text[] := '{}'; t text := quote_literal(p_tenant::text) || '::uuid';
begin
  if 'clc' = any (p_needs) then
    w := w || format('clc as materialized (select distinct coalesce(case when jsonb_typeof(x) = ''string'' then x #>> ''{}'' else coalesce(x->>''sourceId'', x->>''contact_id'') end, '''') as id
                        from public.clients cl cross join lateral jsonb_array_elements(case when jsonb_typeof(cl.contacts) = ''array'' then cl.contacts else ''[]''::jsonb end) x
                       where cl.tenant_id = %s)', t);
  end if;
  if 'touch' = any (p_needs) then
    w := w || format('touch as materialized (select coalesce(jsonb_object_agg(tc.k || '':'' || tc.id::text, jsonb_build_array(tc.at, tc.how)), ''{}''::jsonb) as m from public.mk_touch(%s) tc where tc.id is not null)', t);
  end if;
  if 'dv' = any (p_needs) then
    w := w || format('dv as materialized (select coalesce(jsonb_object_agg(d.id::text, d.v), ''{}''::jsonb) as m from public.mk_deal_values(%s) d where d.id is not null)', t);
  end if;
  return case when cardinality(w) = 0 then '' else 'with ' || array_to_string(w, ', ') || ' ' end;
end $$;

-- the records a dynamic list picks right now (contacts or companies)
create or replace function public.mk_list_ids(p_tenant uuid, p_entity text, p_def jsonb) returns setof uuid
language plpgsql stable set search_path = public set timezone = 'UTC' as $$
declare cp record; tbl text := case when p_entity = 'companies' then 'companies' else 'contacts' end;
begin
  select * into cp from public.mk_lx_compile(p_tenant, p_entity, coalesce(p_def, '{}'::jsonb));
  return query execute format('%s select r.id from public.%I r where r.tenant_id = $1%s',
    public.mk_lx_with(p_tenant, cp.needs), tbl, case when cp.pred is null then '' else ' and (' || cp.pred || ')' end) using p_tenant;
end $$;

-- the people who'd get an e-mail (recipients(): no / invalid e-mail, unsubscribed and doubles left out)
create or replace function public.mk_list_people(p_tenant uuid, p_entity text, p_def jsonb) returns setof uuid
language plpgsql stable set search_path = public set timezone = 'UTC' as $$
declare who text := coalesce(nullif(p_def->>'who', ''), 'all');
begin
  return query
  with ids as (select x as id from public.mk_list_ids(p_tenant, p_entity, p_def) x),
  ppl as (
    -- a contact list: its contacts, in the app's order (by id)
    select c.id, btrim(coalesce(c.email, '')) as em, coalesce(c.marketing_opt_out, false) as optout, row_number() over (order by c.id) as o
      from public.contacts c where p_entity <> 'companies' and c.tenant_id = p_tenant and c.id in (select id from ids)
    union all
    -- a company list: the contacts of each company (all, or the one per company: billing, else the first with an e-mail, else the first)
    select z.id, z.em, z.optout, z.o from (
      select ct.id, btrim(coalesce(ct.email, '')) as em, coalesce(ct.marketing_opt_out, false) as optout,
             row_number() over (order by co.name, co.id, ct.id) as o,
             row_number() over (partition by co.id order by
               (coalesce(ct.is_billing, false) and btrim(coalesce(ct.email, '')) ~* '^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$') desc,
               (btrim(coalesce(ct.email, '')) ~* '^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$') desc, ct.id) as pick
        from public.companies co
        join public.company_contacts cc on cc.company_id = co.id
        join public.contacts ct on ct.id = cc.contact_id and ct.tenant_id = p_tenant
       where p_entity = 'companies' and co.tenant_id = p_tenant and co.id in (select id from ids)) z
     where who <> 'one' or z.pick = 1
  ),
  okish as (
    select p.id, p.em, p.o from ppl p
     where p.em <> '' and p.em ~* '^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$' and not p.optout
       and not exists (select 1 from public.marketing_unsubscribes u where u.tenant_id = p_tenant and lower(u.email) = lower(p.em))
  )
  select distinct on (lower(em)) id from okish order by lower(em), o;
end $$;

/* ---------------------------------------------------------------------
   7 · Workflows › "Joins a list" with a dynamic list, on the server
   --------------------------------------------------------------------- */
-- who's in a dynamic list now → who came in starts its workflows (154's rules, the company passed in)
create or replace function public.mk_dyn_apply(p_list uuid, p_tenant uuid, p_contacts uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare seeded boolean; c record; n_left integer := 0; n_in integer := 0; made integer := 0;
begin
  seeded := exists (select 1 from public.mk_dynamic_members where list_id = p_list);
  update public.mk_dynamic_members m set left_at = now()
   where m.list_id = p_list and m.left_at is null and not (m.contact_id = any (coalesce(p_contacts, '{}'::uuid[])));
  get diagnostics n_left = row_count;
  for c in
    with x as (select distinct u.id from unnest(coalesce(p_contacts, '{}'::uuid[])) u(id)),
    ins as (
      insert into public.mk_dynamic_members (list_id, contact_id, tenant_id)
      select p_list, x.id, p_tenant from x
      on conflict (list_id, contact_id) do update
        set entries = public.mk_dynamic_members.entries + 1, joined_at = now(), left_at = null
        where public.mk_dynamic_members.left_at is not null
      returning contact_id, entries)
    select * from ins
  loop
    n_in := n_in + 1;
    begin made := made + public.mk_wf_dyn_runs(p_list, c.contact_id, c.entries, seeded);
    exception when others then null; end;
  end loop;
  if made > 0 then
    insert into public.mk_workflow_events (tenant_id, workflow_id, kind, detail)
    select w.tenant_id, w.id, 'enrol', jsonb_build_object('list', p_list, 'came_in', n_in, 'dynamic', true)
      from public.mk_workflows w
     where w.status = 'active' and w.trigger->>'kind' = 'list' and w.trigger->>'list_id' = p_list::text and w.tenant_id is not distinct from p_tenant;
  end if;
  return jsonb_build_object('came_in', n_in, 'left', n_left, 'started', made, 'first', not seeded);
end $$;

create or replace function public.mk_dyn_sync_list(p_list uuid) returns jsonb
language plpgsql security definer set search_path = public set timezone = 'UTC' as $$
declare l record; ids uuid[];
begin
  select id, tenant_id, kind, entity, definition into l from public.marketing_lists where id = p_list;
  if not found or l.kind <> 'dynamic' or l.tenant_id is null then return jsonb_build_object('error', 'not a dynamic list'); end if;
  ids := array(select public.mk_list_people(l.tenant_id, l.entity, coalesce(l.definition, '{}'::jsonb)));
  return public.mk_dyn_apply(p_list, l.tenant_id, ids) || jsonb_build_object('people', cardinality(ids));
end $$;

-- every 5 minutes: each dynamic list that starts an active workflow
create or replace function public.mk_dyn_sync_all() returns jsonb
language plpgsql security definer set search_path = public as $$
declare l record; r jsonb; done integer := 0; errs integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('mk_dyn_sync_all')) then return jsonb_build_object('skipped', 'already running'); end if;
  for l in
    select distinct ml.id from public.mk_workflows w
      join public.marketing_lists ml on ml.id::text = w.trigger->>'list_id' and ml.kind = 'dynamic' and ml.tenant_id is not distinct from w.tenant_id
     where w.status = 'active' and w.trigger->>'kind' = 'list'
  loop
    begin
      r := public.mk_dyn_sync_list(l.id);
      done := done + 1;
    exception when others then
      errs := errs + 1;
      insert into public.mk_list_parity (list_id, tenant_id, note) select l.id, ml.tenant_id, left('sync failed: ' || sqlerrm, 500) from public.marketing_lists ml where ml.id = l.id;
    end;
  end loop;
  return jsonb_build_object('lists', done, 'errors', errs);
end $$;

-- the app checks its own result against the server's (and keeps the differences)
create table if not exists public.mk_list_parity (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid references public.marketing_lists(id) on delete cascade,
  tenant_id   uuid,
  at          timestamptz not null default now(),
  n_app       integer,
  n_server    integer,
  only_app    uuid[],
  only_server uuid[],
  note        text
);
create index if not exists mk_list_parity_list on public.mk_list_parity (list_id, at desc);
alter table public.mk_list_parity enable row level security;
drop policy if exists tenant_isolation on public.mk_list_parity;
create policy tenant_isolation on public.mk_list_parity for all to authenticated using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()));

/* ---- what the app calls ---- */
-- work out one list now and start its workflows for whoever came in
create or replace function public.mk_dyn_sync_now(p_list uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t uuid := public.current_tenant();
begin
  if t is null or not exists (select 1 from public.marketing_lists where id = p_list and tenant_id = t) then return jsonb_build_object('error', 'not your list'); end if;
  if not exists (select 1 from public.mk_workflows w where w.tenant_id = t and w.status = 'active' and w.trigger->>'kind' = 'list' and w.trigger->>'list_id' = p_list::text) then
    return jsonb_build_object('skipped', 'no active workflow starts with this list');
  end if;
  return public.mk_dyn_sync_list(p_list);
end $$;

-- the browser's people (154) are no longer used: the server works the list out itself
create or replace function public.mk_sync_dynamic_list(p_list uuid, p_contacts uuid[]) returns jsonb
language sql security definer set search_path = public as $$ select public.mk_dyn_sync_now(p_list) $$;

-- the records of any rules, worked out by the server (for the app's own check)
create or replace function public.mk_list_server_ids(p_entity text, p_def jsonb) returns uuid[]
language plpgsql security definer set search_path = public set timezone = 'UTC' as $$
declare t uuid := public.current_tenant();
begin
  if t is null then return '{}'; end if;
  return array(select public.mk_list_ids(t, p_entity, p_def));
end $$;

-- the app's result for a saved list vs the server's: differences kept in mk_list_parity
create or replace function public.mk_list_check(p_list uuid, p_app uuid[]) returns jsonb
language plpgsql security definer set search_path = public set timezone = 'UTC' as $$
declare t uuid := public.current_tenant(); l record; srv uuid[]; a uuid[]; s uuid[];
begin
  select id, tenant_id, kind, entity, definition into l from public.marketing_lists where id = p_list;
  if t is null or not found or l.tenant_id is distinct from t then return jsonb_build_object('error', 'not your list'); end if;
  if l.kind <> 'dynamic' then return jsonb_build_object('skipped', 'fixed list'); end if;
  srv := array(select public.mk_list_ids(t, l.entity, coalesce(l.definition, '{}'::jsonb)));
  a := array(select x from unnest(coalesce(p_app, '{}'::uuid[])) x except select y from unnest(srv) y);
  s := array(select y from unnest(srv) y except select x from unnest(coalesce(p_app, '{}'::uuid[])) x);
  if cardinality(a) > 0 or cardinality(s) > 0 then
    insert into public.mk_list_parity (list_id, tenant_id, n_app, n_server, only_app, only_server)
    values (p_list, t, cardinality(coalesce(p_app, '{}'::uuid[])), cardinality(srv), a[1:50], s[1:50]);
  end if;
  return jsonb_build_object('app', cardinality(coalesce(p_app, '{}'::uuid[])), 'server', cardinality(srv), 'only_app', cardinality(a), 'only_server', cardinality(s));
end $$;

/* ---- who may run what ---- */
do $$
declare f text;
begin
  foreach f in array array[
    'mk_lx_field(uuid,text,text,text)', 'mk_lx_infer(uuid,text,text)', 'mk_lx_compile(uuid,text,jsonb)', 'mk_list_ids(uuid,text,jsonb)', 'mk_lx_one(jsonb,text,jsonb)',
    'mk_list_people(uuid,text,jsonb)', 'mk_dyn_apply(uuid,uuid,uuid[])', 'mk_dyn_sync_list(uuid)', 'mk_dyn_sync_all()',
    'mk_touch(uuid)', 'mk_deal_values(uuid)', 'mk_line_value(text,jsonb,uuid,float8,float8,text,jsonb)', 'mk_calc_rows(uuid,jsonb,float8,jsonb,jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.mk_dyn_sync_now(uuid) to authenticated;
grant execute on function public.mk_sync_dynamic_list(uuid, uuid[]) to authenticated;
grant execute on function public.mk_list_server_ids(text, jsonb) to authenticated;
grant execute on function public.mk_list_check(uuid, uuid[]) to authenticated;

-- every 5 minutes (a minute before the workflows take their steps)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'marketing-dynamic-lists';
    perform cron.schedule('marketing-dynamic-lists', '1-59/5 * * * *', 'select public.mk_dyn_sync_all()');
  end if;
end $$;
