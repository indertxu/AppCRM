-- =====================================================================
-- 24a_find_tenant.sql — which tenant is Konsolidator (read only)
-- =====================================================================
-- Run it and send me the result. Each row is one tenant with some of its
-- client names, so you can tell which tenant_id is Konsolidator.
-- =====================================================================
select
  to_jsonb(c) ->> 'tenant_id' as tenant_id,
  count(*)                                              as clients,
  (array_agg(c.name order by c.created_at nulls last))[1:8] as sample_clients
from public.clients c
group by 1
order by clients desc;
