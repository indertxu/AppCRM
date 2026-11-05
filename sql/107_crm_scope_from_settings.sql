-- 107: Settings › Companies / Contacts › Security now decides who sees which companies and contacts.
-- Until now the lists ignored those settings: boss / sales manager (/ marketing manager, 106) saw everything,
-- everyone else only what was assigned to them. Now, per page, for the signed-in person:
--   boss (or a level built on Boss) and superadmins → everything;
--   otherwise their own setting › their security role's › their department's › the page's default:
--     all        → every company / contact
--     department → assigned to (or, companies, created by) anyone in their department
--     mine       → assigned to (or, companies, created by) them
--   nothing saved for the page → sales managers and marketing managers everything, the rest "mine" (as before).
-- The saved defaults of "Everything" for Companies / Contacts were never applied, so they become "Only theirs"
-- (with sales managers and marketing managers on "Everything") — the lists show exactly what they showed.

create or replace function public.crm_scope_ids(p_page text)
returns uuid[] language plpgsql stable security definer
set search_path to 'public' as $$
declare
  me uuid := auth.uid();
  p public.profiles%rowtype;
  lvl text;
  base text;
  r jsonb;
  v text;
begin
  if me is null then return array[]::uuid[]; end if;
  select * into p from public.profiles where id = me;
  if not found then return array[me]; end if;
  lvl := lower(coalesce(nullif(p.security_level, ''), nullif(p.role, ''),
           (select d.security_role from public.org_departments d where d.tenant_id = p.tenant_id and d.dept_key = p.department limit 1), ''));
  select lower(s.base_role) into base from public.security_levels s where s.tenant_id = p.tenant_id and s.level_key = lvl limit 1;
  if coalesce(p.is_superadmin, false) or lower(coalesce(p.role, '')) = 'boss' or lvl = 'boss' or base = 'boss' then return null; end if;
  select s.rules into r from public.page_data_scopes s where s.tenant_id = p.tenant_id and s.page = p_page;
  if r is null then
    v := case when coalesce(base, lvl) in ('sales_manager', 'marketing_manager') then 'all' else 'mine' end;
  else
    v := coalesce(r -> 'users' ->> me::text, r -> 'roles' ->> lvl, r -> 'depts' ->> p.department, r ->> 'default', 'all');
  end if;
  if v = 'all' then return null; end if;
  if v = 'department' and p.department is not null then
    return array(select q.id from public.profiles q where q.tenant_id = p.tenant_id and q.department = p.department);
  end if;
  return array[me];
end $$;

do $m$
declare
  def text;
  sel_t constant text := $q$select (coalesce(p.is_superadmin, false) or p.role in ('boss', 'sales_manager', 'marketing_manager')) into lead from public.profiles p where p.id = me;$q$;
  case_t constant text := $q$case when coalesce(lead, false) then '' else format(' and x.assignees @> array[%L::uuid]', me) end$q$;
  gs_t constant text := $q$(coalesce(lead, false) or f.assignees @> array[me])$q$;
  i int;
begin
  -- companies_list
  def := pg_get_functiondef('public.companies_list(jsonb,text,integer,integer,text,jsonb)'::regprocedure);
  if position('crm_scope_ids' in def) = 0 then
    if position(sel_t in def) = 0 or position(case_t in def) = 0 then raise exception 'companies_list: text not found'; end if;
    def := replace(def, '  lead boolean;', '  lead boolean;' || chr(10) || '  see uuid[];');
    def := replace(def, sel_t, $q$see := public.crm_scope_ids('companies');$q$);
    def := replace(def, case_t, $q$case when see is null then '' else format(' and (x.assignees && %L::uuid[] or c.created_by = any(%L::uuid[]))', see, see) end$q$);
    execute def;
  end if;
  -- contacts_list
  def := pg_get_functiondef('public.contacts_list(jsonb,text,integer,integer,text,jsonb)'::regprocedure);
  if position('crm_scope_ids' in def) = 0 then
    if position(sel_t in def) = 0 or position(case_t in def) = 0 then raise exception 'contacts_list: text not found'; end if;
    def := replace(def, '  lead boolean;', '  lead boolean;' || chr(10) || '  see uuid[];');
    def := replace(def, sel_t, $q$see := public.crm_scope_ids('contacts');$q$);
    def := replace(def, case_t, $q$case when see is null then '' else format(' and x.assignees && %L::uuid[]', see) end$q$);
    execute def;
  end if;
  -- global_search: contacts by the Contacts setting, companies by the Companies one
  def := pg_get_functiondef('public.global_search(text,text[],integer)'::regprocedure);
  if position('crm_scope_ids' in def) = 0 then
    i := position($q$if 'company' = any(p_kinds)$q$ in def);
    if position(sel_t in def) = 0 or i = 0 then raise exception 'global_search: text not found'; end if;
    def := replace(substr(def, 1, i - 1), gs_t, '(see_ct is null or f.assignees && see_ct)')
        || replace(substr(def, i), gs_t, '(see_co is null or f.assignees && see_co)');
    def := replace(def, '  lead boolean;', '  lead boolean;' || chr(10) || '  see_ct uuid[];' || chr(10) || '  see_co uuid[];');
    def := replace(def, sel_t, $q$see_ct := public.crm_scope_ids('contacts'); see_co := public.crm_scope_ids('companies');$q$);
    if position(gs_t in def) > 0 then raise exception 'global_search: lead test left'; end if;
    execute def;
  end if;
end $m$;

-- the saved "Everything" defaults were never applied: keep what people actually saw
update public.page_data_scopes s
   set rules = jsonb_set(jsonb_set(s.rules, '{default}', '"mine"'),
                 '{roles}', jsonb_build_object('sales_manager', 'all', 'marketing_manager', 'all') || coalesce(s.rules -> 'roles', '{}'::jsonb)),
       updated_at = now()
 where s.page in ('companies', 'contacts') and coalesce(s.rules ->> 'default', 'all') = 'all';
