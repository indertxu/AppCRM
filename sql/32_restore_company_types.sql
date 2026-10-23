-- =====================================================================
-- 32_restore_company_types.sql — put back in Settings the company types
-- that companies use but that are missing from the Types list
-- =====================================================================
-- Example: "Partner Portugal", "Partner Latam", "1. Konsolidator Iberia Customer"
-- are on companies (probably from an import) but not in Settings › Companies ›
-- Types, so the app hides them. This ADDS them to the list (per tenant).
-- It deletes nothing and can be run any number of times.
-- The last result lists the types that are now in the list.
-- =====================================================================

do $$
declare n int;
begin
  insert into public.crm_options (kind, label, sort, tenant_id)
  select distinct on (x.tenant_id, lower(x.tag)) 'relationship', x.tag, 100, x.tenant_id
  from (
    select (to_jsonb(c) ->> 'tenant_id')::uuid as tenant_id, trim(t.tag) as tag
    from public.companies c
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(to_jsonb(c) -> 'relationship') = 'array' then to_jsonb(c) -> 'relationship' else '[]'::jsonb end) t(tag)
  ) x
  where x.tag <> '' and lower(x.tag) not in ('crm', 'sales', 'client')
    and not exists (
      select 1 from public.crm_options o
      where o.kind = 'relationship' and lower(o.label) = lower(x.tag)
        and (to_jsonb(o) ->> 'tenant_id') is not distinct from x.tenant_id::text);
  get diagnostics n = row_count;
  raise notice 'Added % types to the list.', n;
end $$;

select o.label as type_in_list, (to_jsonb(o) ->> 'tenant_id') as tenant_id
from public.crm_options o
where o.kind = 'relationship'
order by 2, 1;
