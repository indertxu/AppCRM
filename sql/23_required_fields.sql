-- 23 · Required built-in fields for companies and contacts
--
-- Settings › Companies page / Contacts page › Required fields saves which
-- built-in fields (email, VAT, address…) must be filled in. They are kept in
-- crm_options with kind = 'required_field' (labels like 'contact:email', plus a
-- 'contact:*' marker once the team has made its own choice). crm_options already
-- has the multi-tenant set-up (tenant_id stamped by trg_set_tenant, RLS), so no
-- new table is needed.
--
-- The only thing in the way is the CHECK on crm_options.kind. It is rebuilt with
-- 'required_field' added; every kind it already allows is kept. Safe to run more than once.

do $$
declare
  r record;
  kinds text[] := array[]::text[];
  k text;
begin
  for r in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.crm_options'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    -- every value the constraint lists today, written as 'a'::text, 'b'::text … or as '{a,b}'::text[]
    for k in
      select trim(both '"' from trim(x))
      from (select (regexp_matches(r.def, $re$'([^']+)'$re$, 'g'))[1] as m) q,
           lateral unnest(string_to_array(trim(both '{}' from q.m), ',')) x
    loop
      if k <> '' and not k = any(kinds) then kinds := kinds || k; end if;
    end loop;
    execute format('alter table public.crm_options drop constraint %I', r.conname);
  end loop;
  -- kinds already in the table stay valid too
  for k in select distinct kind from public.crm_options where kind is not null loop
    if not k = any(kinds) then kinds := kinds || k; end if;
  end loop;
  foreach k in array array['sector', 'relationship', 'source', 'product_kind', 'ticket_type', 'required_field'] loop
    if not k = any(kinds) then kinds := kinds || k; end if;
  end loop;
  execute format('alter table public.crm_options add constraint crm_options_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

notify pgrst, 'reload schema';

-- Check: the allowed kinds now include required_field
select pg_get_constraintdef(oid) as crm_options_kind_check
from pg_constraint where conrelid = 'public.crm_options'::regclass and conname = 'crm_options_kind_check';
