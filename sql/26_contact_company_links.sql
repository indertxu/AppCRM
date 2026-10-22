-- =====================================================================
-- 26_contact_company_links.sql — people who work for a company but aren't linked to it
-- =====================================================================
-- The link between a contact and a company lives in company_contacts. Some
-- people were only written on the CLIENT (the people list of the client popup,
-- clients.contacts) and never got that link, so the company page doesn't show
-- them. This finds them and, if you say so, adds the missing links.
--
--   PART 1 — PREVIEW (read only). Run the whole file as it is: it shows the
--            missing links and changes nothing.
--   PART 2 — APPLY. Change  'no'  to  'yes'  on the line marked
--            >>> ADD THE LINKS <<<  and run the whole file again.
--
-- It only ADDS links (never removes one) and can be run any number of times.
-- Every link it adds is kept in company_contacts_bk26 (how to take them back
-- is at the end of this file).
-- =====================================================================

do $$
declare
  apply text := 'no';   -- >>> ADD THE LINKS <<<  change 'no' to 'yes' after checking the preview
  n int; has_tenant boolean;
begin
  drop table if exists pg_temp._l26;
  create temp table _l26 as
  with listed as (   -- every person written on a client that has a CRM company
    select cl.id as client_id, cl.name as client_name,
           (to_jsonb(cl) ->> 'company_id')::uuid as company_id,
           coalesce(e.v ->> 'sourceId', e.v ->> 'contact_id', case when jsonb_typeof(e.v) = 'string' then e.v #>> '{}' end) as ref
    from public.clients cl
    cross join lateral jsonb_array_elements(case when jsonb_typeof(cl.contacts) = 'array' then cl.contacts else '[]'::jsonb end) e(v)
    where (to_jsonb(cl) ->> 'company_id') is not null
  )
  select distinct l.company_id, co.name as company, ct.id as contact_id,
         trim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')) as contact,
         ct.email, l.client_name as listed_on_client,
         (to_jsonb(co) ->> 'tenant_id') as tenant_id
  from listed l
  join public.contacts ct on ct.id::text = l.ref
  join public.companies co on co.id = l.company_id
  where l.ref ~* '^[0-9a-f-]{36}$'
    and not exists (select 1 from public.company_contacts cc where cc.company_id = l.company_id and cc.contact_id = ct.id);

  if apply is distinct from 'yes' then
    raise notice 'Preview only. To add the links change ''no'' to ''yes'' on the line marked ADD THE LINKS.';
    return;
  end if;
  select count(*) into n from _l26;
  if n = 0 then raise notice 'Nothing to add: every person on a client is already linked to its company.'; return; end if;

  -- what is added, so it can be taken back
  if to_regclass('public.company_contacts_bk26') is null then
    create table public.company_contacts_bk26 (company_id uuid, contact_id uuid, added_at timestamptz default now());
    alter table public.company_contacts_bk26 enable row level security;
  end if;
  insert into public.company_contacts_bk26 (company_id, contact_id) select company_id, contact_id from _l26;

  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'company_contacts' and column_name = 'tenant_id') into has_tenant;
  if has_tenant then
    -- the SQL editor has no signed-in user, so the company's tenant is written explicitly
    execute 'insert into public.company_contacts (company_id, contact_id, tenant_id)
             select company_id, contact_id, tenant_id::uuid from _l26 on conflict do nothing';
  else
    insert into public.company_contacts (company_id, contact_id) select company_id, contact_id from _l26 on conflict do nothing;
  end if;
  raise notice 'Added % missing links.', n;
end $$;

-- the missing links (in the preview) / the ones just added (after applying)
select coalesce(l.company, 'No missing links') as company, l.contact, l.email, l.listed_on_client, l.company_id, l.contact_id
from (select 1) one left join _l26 l on true
order by 1, 2;

-- To take back what this added:
--   delete from public.company_contacts cc using public.company_contacts_bk26 b
--   where cc.company_id = b.company_id and cc.contact_id = b.contact_id;
