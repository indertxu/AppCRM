-- =====================================================================
-- 42_deals_check.sql — how many deals each tenant really has (read only)
-- =====================================================================
-- Run the whole file. It refreshes the table statistics (ANALYZE) and then
-- shows, per tenant: deals, possible duplicates from the import (same company,
-- same name and same created date) and deals by status.
-- It changes NO data.
-- =====================================================================

analyze public.trackings;
analyze public.tracking_contacts;
analyze public.tracking_products;
analyze public.tracking_employees;
analyze public.tracking_phase_events;

with t as (
  select (to_jsonb(x) ->> 'tenant_id') as tenant_id, x.id, x.company_id, x.status,
         lower(trim(coalesce(to_jsonb(x) ->> 'deal_name', ''))) as dname,
         (x.created_at)::date as cday
  from public.trackings x
),
dups as (
  select tenant_id, sum(n - 1) as extra
  from (select tenant_id, company_id, dname, cday, count(*) as n
          from t group by 1, 2, 3, 4 having count(*) > 1) g
  group by 1
)
select t.tenant_id,
       (select string_agg(c.name, ', ') from (select name from public.clients c
          where (to_jsonb(c) ->> 'tenant_id') = t.tenant_id order by created_at limit 3) c) as sample_clients,
       count(*)                                   as deals,
       coalesce(max(d.extra), 0)                  as possible_duplicates,
       count(*) filter (where t.status = 'won')    as won,
       count(*) filter (where t.status = 'lost')   as lost,
       count(*) filter (where t.status = 'paused') as on_hold,
       count(*) filter (where t.status not in ('won', 'lost', 'paused') or t.status is null) as active
from t left join dups d on d.tenant_id = t.tenant_id
group by t.tenant_id
order by deals desc;
