-- 106: the marketing manager sees every company and contact, like the boss and sales managers.
-- Everyone else still sees only the companies / contacts assigned to them (and, since 105, the ones they add).
-- Changes the "lead" test in companies_list, contacts_list and global_search, and crm_is_lead (105).

create or replace function public.crm_is_lead(p_user uuid)
returns boolean language sql stable security definer
set search_path to 'public' as $$
  select coalesce((select coalesce(p.is_superadmin, false) or p.role in ('boss', 'sales_manager', 'marketing_manager')
                     from public.profiles p where p.id = p_user), false);
$$;

do $m$
declare
  f text;
  def text;
  old_t constant text := $q$p.role in ('boss', 'sales_manager')) into lead$q$;
  new_t constant text := $q$p.role in ('boss', 'sales_manager', 'marketing_manager')) into lead$q$;
begin
  foreach f in array array[
    'public.companies_list(jsonb,text,integer,integer,text,jsonb)',
    'public.contacts_list(jsonb,text,integer,integer,text,jsonb)',
    'public.global_search(text,text[],integer)'] loop
    def := pg_get_functiondef(f::regprocedure);
    if position(new_t in def) > 0 then continue; end if;          -- already done
    if position(old_t in def) = 0 then raise exception 'lead test not found in %', f; end if;
    execute replace(def, old_t, new_t);
  end loop;
end $m$;
