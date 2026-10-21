-- =====================================================================
-- 25_clients_merge_konsolidator.sql — merge the 4 duplicate clients (Konsolidator)
-- =====================================================================
-- Each pair is the consultancy client (projects + calendar) and the one created
-- later from the won deal (products, address, contacts, CRM company).
-- The consultancy client is KEPT (same id, so projects and calendar don't move).
-- From the deal client (the complete one) it takes:
--   * the company data: full name, legal name, CRM company, VAT, address
--   * any other field the kept client has empty
--   * its contacts (added, people already there by e-mail/name are skipped)
--   * its products (and anything else pointing at it)
-- Then the deal client is deleted.
--
--   KEPT (projects)          <- TAKES ITS DATA FROM
--   Electra Caldense         <- Electra Caldense Holding S.L.
--   Humanis                  <- Humanis Healthcare, S.L.
--   Ibervalles               <- Ibervalles Capital Gestión, S.A.
--   Ubimia                   <- Ubimia (Proyectos Formación y Servicios, S.L.)
--
-- All in one transaction: if anything fails, nothing changes.
-- Everything touched is backed up first (tables clients_bk25_*).
-- Undo: 25_clients_merge_konsolidator_undo.sql
-- The last result shows the 4 kept clients as they end up.
-- =====================================================================
begin;

create temp table _m25 (keeper uuid, loser uuid) on commit drop;
insert into _m25 values
  ('ac63c498-833f-4a0f-b258-700203a84570', 'a06b5a66-59d3-4fc0-81fb-7d4b8cbc7947'),  -- Electra Caldense
  ('7f28aaa1-75fd-4769-85da-2e03418f2d23', '73caef7e-e9af-42f5-b9ae-975cbeaa6352'),  -- Humanis
  ('f7ddf7c0-bb72-43fc-bf1d-c831790144c6', 'e8bce6e0-97e5-49f7-b0b1-e36ca30b8231'),  -- Ibervalles
  ('2f4897d5-aa85-436a-8e51-f3102638a15a', '0143d785-4e51-42d8-85d2-f5e7e030b3cf');  -- Ubimia

do $$
declare
  m record; r record; col record; n int; left_refs int;
begin
  -- every client must exist and belong to Konsolidator
  select count(*) into n from public.clients c
  where c.id in (select keeper from _m25 union select loser from _m25)
    and (to_jsonb(c) ->> 'tenant_id') = '11f85bbc-8ef6-442a-bc53-915949f9f013';
  if n <> 8 then
    raise exception 'Expected 8 Konsolidator clients, found %. Already merged? Nothing was changed.', n;
  end if;

  -- base tables (not views) that point at a client
  create temp table _refs25 on commit drop as
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
  join information_schema.tables it on it.table_schema = 'public' and it.table_name = x.t and it.table_type = 'BASE TABLE'
  where t <> 'clients' and t not like 'clients_bk%' and t not like '%\_bk\_%' and t not like '%backup%';

  -- ---------- backups ----------
  drop table if exists public.clients_bk25_clients, public.clients_bk25_moved;
  create table public.clients_bk25_clients as
    select c.* from public.clients c where c.id in (select keeper from _m25 union select loser from _m25);
  alter table public.clients_bk25_clients enable row level security;
  create table public.clients_bk25_moved (tbl text, col text, row_data jsonb, loser uuid, keeper uuid);
  alter table public.clients_bk25_moved enable row level security;
  for r in select * from _refs25 loop
    execute format(
      'insert into public.clients_bk25_moved select %L, %L, to_jsonb(x), m.loser, m.keeper
         from public.%I x join _m25 m on x.%I = m.loser', r.t, r.c, r.t, r.c);
  end loop;

  for m in select * from _m25 loop
    -- 1. company data comes from the deal client (the complete one):
    --    name, legal name, CRM company, VAT and address — wherever it has a value
    update public.clients k set name = l.name
    from public.clients l where k.id = m.keeper and l.id = m.loser and coalesce(trim(l.name), '') <> '';
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'legal_name') then
      update public.clients k set legal_name = coalesce(nullif(trim(l.legal_name), ''), l.name)
      from public.clients l where k.id = m.keeper and l.id = m.loser;
    end if;
    update public.clients k set company_id = l.company_id
    from public.clients l where k.id = m.keeper and l.id = m.loser and l.company_id is not null;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'vat_number') then
      update public.clients k set vat_number = l.vat_number
      from public.clients l where k.id = m.keeper and l.id = m.loser and coalesce(trim(l.vat_number), '') <> '';
    end if;
    update public.clients k set address = l.address
    from public.clients l where k.id = m.keeper and l.id = m.loser
      and l.address is not null and l.address not in ('{}'::jsonb, 'null'::jsonb);

    -- 2. fill every field the kept client has empty (never overwrite)
    for col in select column_name, data_type from information_schema.columns
               where table_schema = 'public' and table_name = 'clients'
                 and column_name not in ('id', 'tenant_id', 'created_at', 'name', 'legal_name', 'contacts') loop
      if col.data_type = 'jsonb' then
        execute format('update public.clients k set %1$I = l.%1$I from public.clients l
                        where k.id = $1 and l.id = $2
                          and (k.%1$I is null or k.%1$I in (''{}''::jsonb, ''[]''::jsonb, ''null''::jsonb))
                          and l.%1$I is not null and l.%1$I not in (''{}''::jsonb, ''[]''::jsonb, ''null''::jsonb)', col.column_name)
          using m.keeper, m.loser;
      elsif col.data_type in ('text', 'character varying') then
        execute format('update public.clients k set %1$I = l.%1$I from public.clients l
                        where k.id = $1 and l.id = $2 and coalesce(trim(k.%1$I), '''') = '''' and coalesce(trim(l.%1$I), '''') <> ''''', col.column_name)
          using m.keeper, m.loser;
      else
        execute format('update public.clients k set %1$I = l.%1$I from public.clients l
                        where k.id = $1 and l.id = $2 and k.%1$I is null and l.%1$I is not null', col.column_name)
          using m.keeper, m.loser;
      end if;
    end loop;

    -- 3. contacts: add the deal client's people not already there (same e-mail or name)
    update public.clients k set contacts = coalesce(case when jsonb_typeof(k.contacts) = 'array' then k.contacts end, '[]'::jsonb) || coalesce((
      select jsonb_agg(e.v) from jsonb_array_elements(case when jsonb_typeof(l.contacts) = 'array' then l.contacts else '[]'::jsonb end) e(v)
      where not exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(k.contacts) = 'array' then k.contacts else '[]'::jsonb end) f(v)
        where (coalesce(trim(e.v ->> 'email'), '') <> '' and lower(trim(e.v ->> 'email')) = lower(trim(f.v ->> 'email')))
           or (coalesce(trim(e.v ->> 'name'), '') <> '' and lower(trim(e.v ->> 'name')) = lower(trim(f.v ->> 'name'))))
    ), '[]'::jsonb)
    from public.clients l where k.id = m.keeper and l.id = m.loser;

    -- 4. move everything that points at the deal client to the kept one
    for r in select * from _refs25 loop
      execute format('update public.%I set %I = $1 where %I = $2', r.t, r.c, r.c) using m.keeper, m.loser;
    end loop;

    -- 5. nothing may still point at the deal client
    left_refs := 0;
    for r in select * from _refs25 loop
      execute format('select count(*) from public.%I where %I = $1', r.t, r.c) into n using m.loser;
      left_refs := left_refs + n;
    end loop;
    if left_refs > 0 then raise exception 'Client % still referenced (% rows). Nothing was changed.', m.loser, left_refs; end if;

    delete from public.clients where id = m.loser;
  end loop;

  raise notice 'Merged 4 duplicate clients.';
end $$;

commit;

-- result: the 4 kept clients
select c.id, c.name, to_jsonb(c) ->> 'legal_name' as legal_name, co.name as crm_company,
       c.address, jsonb_array_length(coalesce(c.contacts, '[]'::jsonb)) as contacts,
       (select count(*) from public.projects p where p.client_id = c.id) as projects,
       (select count(*) from public.client_products p where p.client_id = c.id) as products
from public.clients c
left join public.companies co on co.id = (to_jsonb(c) ->> 'company_id')::uuid
where c.id in ('ac63c498-833f-4a0f-b258-700203a84570', '7f28aaa1-75fd-4769-85da-2e03418f2d23',
               'f7ddf7c0-bb72-43fc-bf1d-c831790144c6', '2f4897d5-aa85-436a-8e51-f3102638a15a')
order by c.name;
