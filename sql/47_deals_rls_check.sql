-- =====================================================================
-- 47_deals_rls_check.sql — read only. Send me the result.
-- =====================================================================
-- Deals (trackings) take ~1 ms PER ROW to read because of their access
-- rules, so reading all 9,300 hits the 8-second limit and every page that
-- needs deals (contacts, companies, deals, projects, clients) hangs.
-- This lists those rules and the functions they call, so I can fix them.
-- =====================================================================
with pol as (
  select tablename, policyname, cmd, roles::text as roles, coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
  from pg_policies
  where schemaname = 'public'
    and tablename in ('trackings', 'tracking_contacts', 'contacts', 'companies', 'company_contacts')
),
fn as (
  select distinct p.proname, pg_get_functiondef(p.oid) as def, p.provolatile, p.prosecdef
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where exists (select 1 from pol where pol.qual ~* ('\m' || p.proname || '\s*\(') or pol.with_check ~* ('\m' || p.proname || '\s*\('))
)
select 'POLICY' as kind, tablename || ' · ' || policyname || ' · ' || cmd || ' · ' || roles as name,
       'USING: ' || qual || case when with_check <> '' then '   CHECK: ' || with_check else '' end as detail
from pol
union all
select 'FUNCTION', proname || case provolatile when 'v' then ' (volatile)' when 's' then ' (stable)' else ' (immutable)' end
                           || case when prosecdef then ' security definer' else '' end,
       def
from fn
union all
select 'TRIGGER', event_object_table || ' · ' || trigger_name, action_timing || ' ' || event_manipulation || ' ' || action_statement
from information_schema.triggers
where event_object_schema = 'public' and event_object_table in ('trackings', 'tracking_contacts')
order by 1 desc, 2;
