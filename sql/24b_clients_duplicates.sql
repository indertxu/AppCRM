-- =====================================================================
-- 24b_clients_duplicates.sql — duplicate clients, full detail (read only)
-- =====================================================================
-- Already set to Konsolidator. Run the whole file (it changes NOTHING) and
-- export the result (Download → CSV) and send it to me.
--
-- One row per Konsolidator client. First the ones with a possible twin (grp
-- filled), then all the others (grp empty) so you can spot twins it missed.
-- Twins are found by same CRM company, same name without accents / legal form, one
-- name starting with the other, or same VAT. For each one you get:
--   grp        the duplicate group number
--   fields     every non-empty field of the client
--   attached   how many rows of each table point at it (projects, invoices…)
-- =====================================================================

-- name without accents, punctuation or legal form: "Acme Iberia, S.L." = "acme iberia"
create or replace function pg_temp.k_name(s text) returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(
    lower(translate(coalesce(s, ''), 'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc')),
    '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'),
    '\s(s ?l ?u?|s ?a ?u?|slp|sll|sccl|scp|cb|sociedad limitada|sociedad anonima|ab|gmbh|ltd|llc|inc|bv|srl|spa|sas|sarl|plc|ag|nv)$', ''))
$$;
create or replace function pg_temp.k_vat(s text) returns text language sql immutable as $$
  select nullif(regexp_replace(upper(coalesce(s, '')), '[^A-Z0-9]', '', 'g'), '')
$$;

-- rows pointing at one client, per table: {"projects": 3, "invoices": 12, …}
create or replace function pg_temp.k_attached(cid uuid) returns jsonb language plpgsql as $$
declare r record; n int; out jsonb := '{}'::jsonb;
begin
  for r in
    select distinct t, c from (
      select cl.relname::text t, att.attname::text c
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
      join unnest(con.conkey) k(attnum) on true
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
      where con.contype = 'f' and con.confrelid = 'public.clients'::regclass
      union
      select table_name::text, column_name::text from information_schema.columns
      where table_schema = 'public' and column_name = 'client_id' and data_type = 'uuid'
    ) x
    where t <> 'clients' and t not like 'clients_bk_%' and t not like '%\_bk\_%'
    order by 1
  loop
    execute format('select count(*) from public.%I where %I = $1', r.t, r.c) into n using cid;
    if n > 0 then out := out || jsonb_build_object(r.t || case when r.c <> 'client_id' then '.' || r.c else '' end, n); end if;
  end loop;
  return out;
end $$;

with params as (
  select '11f85bbc-8ef6-442a-bc53-915949f9f013'::uuid as tenant   -- >>> TENANT <<< (Konsolidator)
),
c as (
  select cl.*, to_jsonb(cl) as j,
         pg_temp.k_name(cl.name) as nk,
         pg_temp.k_vat(to_jsonb(cl) ->> 'vat_number') as vk,
         (to_jsonb(cl) ->> 'company_id') as cid
  from public.clients cl, params p
  where (to_jsonb(cl) ->> 'tenant_id')::uuid = p.tenant
),
linked as (   -- a client is in a group with every client sharing company, name or VAT
  select a.id,
         min(b.id::text) as g
  from c a
  join c b on (a.cid is not null and a.cid = b.cid)
           or (a.nk <> '' and a.nk = b.nk)
           or (a.vk is not null and a.vk = b.vk)
           or (length(a.nk) >= 4 and b.nk like a.nk || ' %')   -- "ibervalles" ~ "ibervalles capital gestion"
           or (length(b.nk) >= 4 and a.nk like b.nk || ' %')
  group by a.id
),
grp as (
  select l.id, l.g, min(c.nk) over (partition by l.g) as gname,
         count(*) over (partition by l.g) as n
  from linked l join c on c.id = l.id
)
select
  case when grp.n > 1 then dense_rank() over (order by grp.n > 1 desc, grp.gname, grp.g) end as grp,
  c.id                                         as client_id,
  c.name,
  c.cid                                        as company_id,
  co.name                                      as crm_company,
  c.vk                                         as vat,
  (c.j ->> 'created_at')::timestamptz::date    as created,
  pg_temp.k_attached(c.id)                     as attached,
  jsonb_strip_nulls(c.j - 'tenant_id')         as fields
from grp
join c on c.id = grp.id
left join public.companies co on co.id = c.cid::uuid
order by grp.n > 1 desc, grp.gname, created nulls last, c.name;
