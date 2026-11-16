-- =====================================================================
-- 140 · Enterprise · Who reads whose mail (SQL 139), more flexible:
--   • new scope "reports": their own + everyone below them in the org chart
--     (profiles.manager_id, all levels down)
--   • "people" picked on a rule now add to any scope ("their department
--     + Ana"), not only to "own"
-- Same settings row (page_data_scopes, page 'mail_view'). Safe to re-run.
-- =====================================================================
create or replace function public.mail_can_see(p_tenant uuid, p_mailbox uuid, p_ticket uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my record;
  owner_id uuid;
  od text;
  rules jsonb;
  r jsonb;
  lvl text;
  see text;
begin
  if me is null then return false; end if;
  select id, lower(coalesce(security_level, role, '')) as lvl, lower(coalesce(role, '')) as role, department, coalesce(is_superadmin, false) as sa, tenant_id
    into my from profiles where id = me;
  if my.id is null then return false; end if;
  if my.sa or my.role = 'boss' or my.lvl = 'boss' then return true; end if;
  if my.tenant_id is distinct from p_tenant then return false; end if;
  if p_ticket is not null and exists (select 1 from tracking_tasks where id = p_ticket and assignee_id = me) then return true; end if;
  select m.owner_id into owner_id from ticket_mailboxes m where m.id = p_mailbox;
  if owner_id = me then return true; end if;
  rules := public.mail_view_rules(p_tenant);
  lvl := my.lvl;
  r := coalesce(rules->'users'->(me::text), rules->'roles'->lvl, rules->'depts'->coalesce(my.department, ''), rules->'everyone');
  if r is null or jsonb_typeof(r) <> 'object' then
    r := case when lvl ~ 'manager' or my.role ~ 'manager' then '{"see":"department","shared":true}'::jsonb else '{"see":"own","shared":true}'::jsonb end;
  end if;
  see := coalesce(r->>'see', 'own');
  if owner_id is null then return coalesce((r->>'shared')::boolean, true); end if;
  if see = 'all' then return true; end if;
  -- people picked add to any scope
  if jsonb_typeof(r->'people') = 'array' and r->'people' ? owner_id::text then return true; end if;
  if see = 'reports' then
    return exists (
      with recursive below(id) as (
        select p.id from profiles p where p.manager_id = me and p.tenant_id = p_tenant
        union
        select p.id from profiles p join below b on p.manager_id = b.id where p.tenant_id = p_tenant
      ) select 1 from below where id = owner_id);
  end if;
  select department into od from profiles where id = owner_id;
  if see = 'department' then return my.department is not null and od = my.department; end if;
  if see = 'teams' then return od is not null and jsonb_typeof(r->'depts') = 'array' and r->'depts' ? od; end if;
  return false;
end $$;
grant execute on function public.mail_can_see(uuid, uuid, uuid) to authenticated;
