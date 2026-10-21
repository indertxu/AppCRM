-- 21 · "Multiple choice" custom fields for companies and contacts
--
-- The app now stores a multiple-choice value as a JSON list in `custom`
-- (e.g. custom->'<field id>' = ["Konsolidator Iberia Customer", "Partner Latam"]).
-- `custom` is already jsonb, so no data change is needed.
--
-- The only thing that can block it: a CHECK constraint on company_fields.type /
-- contact_fields.type that lists the allowed types. If one exists, it is rebuilt
-- with 'multiselect' added next to 'select' (any other types it allows are kept).
-- If none exists, nothing changes. Safe to run more than once.

do $$
declare
  t text;
  r record;
  nd text;
begin
  foreach t in array array['company_fields', 'contact_fields'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    for r in
      select con.conname, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      where con.conrelid = ('public.' || t)::regclass
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) ilike '%''select''%'
        and pg_get_constraintdef(con.oid) not ilike '%multiselect%'   -- already allows it → leave alone
    loop
      nd := regexp_replace(r.def, '''select''(::[a-z ]+)?', '''select''\1, ''multiselect''\1');
      if nd = r.def then
        nd := 'CHECK (type in (''text'',''number'',''date'',''boolean'',''select'',''multiselect''))';
      end if;
      execute format('alter table public.%I drop constraint %I', t, r.conname);
      execute format('alter table public.%I add constraint %I %s', t, r.conname, nd);
      raise notice '%.%: % -> %', t, r.conname, r.def, nd;
    end loop;
  end loop;
end $$;

-- Check: the type rules now in place (no rows = no rule, any type is allowed).
select conrelid::regclass as "table", conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in (to_regclass('public.company_fields'), to_regclass('public.contact_fields')) and contype = 'c';
