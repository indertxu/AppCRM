-- =====================================================================
-- 77_partner_tag.sql — partners are companies with a "partner" type
-- =====================================================================
-- One system instead of two:
--   · in Settings › Companies page › "What a company can be", any type can be
--     switched on as a partner type (crm_options.is_partner). Every company
--     with that type is a partner: it is offered as the partner of a deal line
--     in the calculator, and as "Brought by" on other companies.
--   · each partner keeps what it takes, a % or a fixed amount, in its own
--     panel (partner_rates, the general rate — as before, editable per deal).
--   · companies.partner_id: the partner that brought this company ("Brought by
--     partner" in its panel), filled once from a custom field named "…partner…".
-- Types already called "…partner…" are switched on, so nothing changes today.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

alter table public.crm_options add column if not exists is_partner boolean not null default false;
update public.crm_options set is_partner = true
 where kind = 'relationship' and label ~* 'partner' and not is_partner
   and not exists (select 1 from public.crm_options x where x.tenant_id is not distinct from crm_options.tenant_id and x.kind = 'relationship' and x.is_partner);

alter table public.companies add column if not exists partner_id uuid references public.companies(id) on delete set null;
create index if not exists companies_partner on public.companies (partner_id) where partner_id is not null;

-- "Brought by" filled from a custom company field called "…partner…" that holds a company's name
-- (the field stays; remove it in Settings once you have checked "Brought by partner").
do $$ begin
  if to_regclass('public.company_fields') is not null then
    update public.companies c set partner_id = p.id
      from public.company_fields f, public.companies p
     where c.partner_id is null and f.label ~* 'partner' and f.type in ('select', 'multiselect', 'text')
       and (f.tenant_id is not distinct from c.tenant_id)
       and p.id <> c.id and p.tenant_id is not distinct from c.tenant_id
       and lower(btrim(p.name)) = lower(btrim(case jsonb_typeof(c.custom -> f.id::text)
             when 'array' then c.custom -> f.id::text ->> 0 else c.custom ->> f.id::text end));
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

select (select string_agg(label, ', ' order by label) from public.crm_options where kind = 'relationship' and is_partner) as partner_types,
       (select count(*) from public.companies where partner_id is not null) as companies_brought_by_a_partner;
