-- =====================================================================
-- 30_orphan_company_types.sql — types removed in Settings still on companies
-- =====================================================================
-- A type you removed from the list (Settings › Companies page › Types) could
-- stay written on the companies that had it. The app already hides those
-- now; this cleans the data too.
--
--   1. Run the whole file as it is: it only shows what it would remove.
--   2. If it looks right, change  'no'  to  'yes'  on the line marked
--      >>> REMOVE THEM <<<  and run the whole file again.
--
-- Built-in types (crm, sales, client) are never touched. What is removed is
-- kept in companies_bk30_types so it can be put back.
-- =====================================================================

do $$
declare
  apply text := 'no';   -- >>> REMOVE THEM <<<  change 'no' to 'yes' after checking the preview
  is_json boolean;
  n int;
begin
  select data_type in ('json', 'jsonb') into is_json
  from information_schema.columns
  where table_schema = 'public' and table_name = 'companies' and column_name = 'relationship';
  if is_json is null then raise exception 'companies.relationship not found.'; end if;

  drop table if exists pg_temp._o30;
  -- every (company, type) whose type is no longer on that company's tenant list
  create temp table _o30 as
  select c.id as company_id, c.name as company, t.tag as type,
         (to_jsonb(c) ->> 'tenant_id') as tenant_id
  from public.companies c
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(to_jsonb(c) -> 'relationship') = 'array' then to_jsonb(c) -> 'relationship' else '[]'::jsonb end) t(tag)
  where lower(t.tag) not in ('crm', 'sales', 'client')
    and not exists (
      select 1 from public.crm_options o
      where o.kind = 'relationship' and lower(o.label) = lower(t.tag)
        and (to_jsonb(o) ->> 'tenant_id') is not distinct from (to_jsonb(c) ->> 'tenant_id'));

  if apply is distinct from 'yes' then
    raise notice 'Preview only. To remove them change ''no'' to ''yes'' on the line marked REMOVE THEM.';
    return;
  end if;
  select count(*) into n from _o30;
  if n = 0 then raise notice 'No orphan types.'; return; end if;

  if to_regclass('public.companies_bk30_types') is null then
    create table public.companies_bk30_types (company_id uuid, type text, removed_at timestamptz default now());
    alter table public.companies_bk30_types enable row level security;
  end if;
  insert into public.companies_bk30_types (company_id, type) select company_id, type from _o30;

  if is_json then
    update public.companies c set relationship = (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(to_jsonb(c.relationship)) x
      where not exists (select 1 from _o30 o where o.company_id = c.id and o.type = x))
    where c.id in (select company_id from _o30);
  else
    update public.companies c set relationship = (
      select coalesce(array_agg(x), '{}') from unnest(c.relationship) x
      where not exists (select 1 from _o30 o where o.company_id = c.id and o.type = x))
    where c.id in (select company_id from _o30);
  end if;
  raise notice 'Removed % orphan types.', n;
end $$;

-- what would be removed (preview) / what was removed (after applying)
select coalesce(o.company, 'No orphan types') as company, o.type, o.company_id
from (select 1) one left join _o30 o on true
order by 1, 2;

-- To put them back (text[] column; for jsonb use  c.relationship || to_jsonb(b.type)):
--   update public.companies c set relationship = array_append(c.relationship, b.type)
--   from public.companies_bk30_types b where b.company_id = c.id;
