-- 113 · ENTERPRISE · A company's account manager = the starred person of its Visibility
--   company_assignees.is_manager   one per company (partial unique index)
--   companies_fx / companies_view_sql: filter, column and sort "account_manager" (by name)
--   company_row_json: "__manager" for the list rows
--   The old custom field "Account Manager" (a fixed list of names, with "Deleted User") becomes the star:
--   each name is matched to a person of the workspace (full name, or a first name only one person has),
--   that person gets access and the star; the field goes, and list layouts that showed it show the new column.
alter table public.company_assignees add column if not exists is_manager boolean not null default false;
create unique index if not exists company_assignees_one_manager on public.company_assignees (company_id) where is_manager;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.companies_fx(text, text, jsonb)'::regprocedure);
  if position('account_manager' in d) = 0 then
    d := replace(d, $a$  if k = 'visible_to' then$a$,
      $a$  if k = 'account_manager' then return $s$coalesce((select a.profile_id::text from public.company_assignees a where a.company_id = c.id and a.is_manager limit 1), '')$s$; end if;
  if k = 'visible_to' then$a$);
    execute d;
  end if;
  d := pg_get_functiondef('public.companies_view_sql(jsonb, text, jsonb)'::regprocedure);
  if position('account_manager' in d) = 0 then
    d := replace(d, $a$    elsif c ->> 'key' = 'created_by' then$a$,
      $a$    elsif c ->> 'key' = 'account_manager' then e := $s$nullif(public.fx_norm((select concat_ws(' ', pr.first_name, pr.last_name) from public.company_assignees a join public.profiles pr on pr.id = a.profile_id where a.company_id = c.id and a.is_manager limit 1)), '')$s$;
    elsif c ->> 'key' = 'created_by' then$a$);
    execute d;
  end if;
end $$;

create or replace function public.company_row_json(p_id uuid)
returns jsonb language sql stable set search_path = public, extensions as $$
  select (to_jsonb(c) - 'tenant_id') || jsonb_build_object(
    '__types', to_jsonb(x.types), '__status', to_jsonb(x.status), '__pipes', to_jsonb(x.pipelines),
    '__parentName', x.parent_name, '__kids', x.kids, '__count', x.contact_count, '__assignees', to_jsonb(x.assignees),
    '__manager', (select a.profile_id from public.company_assignees a where a.company_id = c.id and a.is_manager limit 1))
  from public.companies c join public.company_facts x on x.company_id = c.id
  where c.id = p_id
$$;

-- the old "Account Manager" field → the star
do $$
declare f record;
begin
  create temp table _am (company_id uuid, tenant_id uuid, pid uuid) on commit drop;
  for f in select id, tenant_id from public.company_fields where lower(btrim(label)) = 'account manager' loop
    insert into _am
    with names as (
      select distinct btrim(c.custom ->> f.id::text) v from public.companies c
       where c.tenant_id = f.tenant_id and coalesce(btrim(c.custom ->> f.id::text), '') <> ''
    ), map as (
      select n.v, coalesce(
        (select p.id from public.profiles p where p.tenant_id = f.tenant_id and lower(btrim(concat_ws(' ', p.first_name, p.last_name))) = lower(n.v) limit 1),
        (select (array_agg(p.id))[1] from public.profiles p where p.tenant_id = f.tenant_id and lower(btrim(p.first_name)) = lower(split_part(n.v, ' ', 1)) having count(*) = 1)) pid
      from names n
    )
    select c.id, c.tenant_id, m.pid from public.companies c join map m on m.v = btrim(c.custom ->> f.id::text)
     where c.tenant_id = f.tenant_id and m.pid is not null;
    -- layouts that showed the old field show the new column
    update public.profiles set prefs = jsonb_set(prefs, '{companyColumns}',
      (select jsonb_agg(case when e = to_jsonb(f.id::text) then '"account_manager"'::jsonb else e end) from jsonb_array_elements(prefs -> 'companyColumns') e))
     where tenant_id = f.tenant_id and jsonb_typeof(prefs -> 'companyColumns') = 'array' and (prefs -> 'companyColumns') ? f.id::text;
  end loop;
  insert into public.company_assignees (tenant_id, company_id, profile_id)
  select m.tenant_id, m.company_id, m.pid from _am m
   where not exists (select 1 from public.company_assignees a where a.company_id = m.company_id and a.profile_id = m.pid);
  update public.company_assignees a set is_manager = true
   where a.id in (select distinct on (a2.company_id) a2.id from public.company_assignees a2 join _am m on m.company_id = a2.company_id and m.pid = a2.profile_id
                   where not exists (select 1 from public.company_assignees x where x.company_id = a2.company_id and x.is_manager)
                   order by a2.company_id, a2.created_at, a2.id);
  delete from public.company_fields where lower(btrim(label)) = 'account manager';
end $$;
