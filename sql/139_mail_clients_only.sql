-- =====================================================================
-- 139 · Enterprise · E-mail in the app: clients only, and who sees whose.
--
-- 1. Only clients' mail. An e-mail is kept (and shown) only when the other
--    side is a client: a person on a client's contact list, someone at the
--    client's company (its e-mail, its website's domain, its contacts and
--    their domains), or an address / domain a client mail rule files to a
--    client. Public mail domains (gmail, outlook…) only count by the exact
--    address, and the company's own domain never makes a mail a client's.
--    Outgoing mail counts when one of the recipients is a client.
--    → the sync drops everything else before it is stored (trigger), and what
--      is already stored is hidden unless it passes (restrictive RLS).
--    Settings › Tickets › E-mail can widen it to "clients and the CRM"
--    (companies and contacts too — the old rule, needed for campaign replies);
--    rules.keep in page_data_scopes, page 'mail_view'. Default: clients.
-- 2. Who sees whose mail, by mailbox owner (page_data_scopes 'mail_view'):
--    a person › their security role › their department › everyone, then:
--      all          every mailbox of the company
--      department   their department's people's mailboxes
--      teams        the people of the departments picked (rules.*.depts)
--      people       their own and the people picked (rules.*.people)
--      own          only their own
--    plus `shared` (shared mailboxes such as support@, default yes) and always
--    the mail of tickets assigned to them. Bosses and superadmins see all.
--    Nothing saved: bosses all, managers their department, the rest their own.
-- Nothing is deleted: mail hidden by this is still in the table.
-- Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

/* ---------- the settings (one row per company in page_data_scopes) ---------- */
create or replace function public.mail_view_rules(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select rules from page_data_scopes where tenant_id = p_tenant and page = 'mail_view' limit 1), '{}'::jsonb);
$$;

/* ---------- 1. is this address a client's? ---------- */
create or replace function public.mail_is_client(p_tenant uuid, p_email text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  d text := public.mail_domain(p_email);
  pub boolean;
begin
  if p_tenant is null or d is null then return false; end if;
  if coalesce(auth.role(), '') = 'authenticated' and p_tenant is distinct from public.current_tenant() then return false; end if;
  pub := public.mail_public_domain(d);

  -- the exact address on a client's contact list
  if exists (select 1 from clients cl
               cross join lateral jsonb_array_elements(case when jsonb_typeof(cl.contacts) = 'array' then cl.contacts else '[]'::jsonb end) x
             where cl.tenant_id = p_tenant and lower(trim(x->>'email')) = e) then return true; end if;
  -- the exact address of the client's company or of one of its contacts
  if exists (select 1 from clients cl join companies co on co.id = cl.company_id
             where cl.tenant_id = p_tenant and lower(trim(co.email)) = e) then return true; end if;
  if exists (select 1 from clients cl join company_contacts cc on cc.company_id = cl.company_id join contacts ct on ct.id = cc.contact_id
             where cl.tenant_id = p_tenant and lower(trim(ct.email)) = e) then return true; end if;
  -- a client mail rule naming the address
  if exists (select 1 from ticket_mail_rules r
               cross join lateral jsonb_array_elements_text(case when jsonb_typeof(r.conditions->'from_emails') = 'array' then r.conditions->'from_emails' else '[]'::jsonb end) f
             where r.tenant_id = p_tenant and r.scope = 'client' and r.active and r.set_fields ? 'client_id'
               and lower(trim(f)) = e) then return true; end if;

  -- by domain: never a public one, never the company's own
  if pub then return false; end if;
  if exists (select 1 from profiles where tenant_id = p_tenant and public.mail_domain(email) = d) then return false; end if;
  if exists (select 1 from ticket_mail_rules r
               cross join lateral jsonb_array_elements_text(case when jsonb_typeof(r.conditions->'from_emails') = 'array' then r.conditions->'from_emails' else '[]'::jsonb end) f
             where r.tenant_id = p_tenant and r.scope = 'client' and r.active and r.set_fields ? 'client_id'
               and lower(trim(f)) in ('@' || d, d)) then return true; end if;
  if exists (select 1 from clients cl join companies co on co.id = cl.company_id
             where cl.tenant_id = p_tenant and (public.site_domain(co.website) = d or public.mail_domain(co.email) = d)) then return true; end if;
  if exists (select 1 from clients cl
               cross join lateral jsonb_array_elements(case when jsonb_typeof(cl.contacts) = 'array' then cl.contacts else '[]'::jsonb end) x
             where cl.tenant_id = p_tenant and public.mail_domain(x->>'email') = d) then return true; end if;
  if exists (select 1 from clients cl join company_contacts cc on cc.company_id = cl.company_id join contacts ct on ct.id = cc.contact_id
             where cl.tenant_id = p_tenant and public.mail_domain(ct.email) = d) then return true; end if;
  return false;
end $$;
grant execute on function public.mail_is_client(uuid, text) to authenticated;

/* One e-mail: kept / shown? (clients only, or the CRM when the company chose so) */
create or replace function public.mail_row_allowed(p_tenant uuid, p_dir text, p_from text, p_to jsonb, p_cc jsonb)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  crm boolean := coalesce(public.mail_view_rules(p_tenant)->>'keep', 'clients') = 'crm';
begin
  if crm then return public.mail_row_known(p_tenant, p_dir, p_from, p_to, p_cc); end if;
  if p_dir = 'out' then
    return exists (
      select 1 from jsonb_array_elements(
        (case when jsonb_typeof(p_to) = 'array' then p_to else '[]'::jsonb end) ||
        (case when jsonb_typeof(p_cc) = 'array' then p_cc else '[]'::jsonb end)) r
      where public.mail_is_client(p_tenant, case when jsonb_typeof(r) = 'string' then r #>> '{}' else r->>'email' end));
  end if;
  return public.mail_is_client(p_tenant, p_from);
end $$;
grant execute on function public.mail_row_allowed(uuid, text, text, jsonb, jsonb) to authenticated;

-- the sync: only what passes is stored
create or replace function public.mail_keep_known()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.mail_row_allowed(coalesce(new.tenant_id, public.current_tenant()), new.direction, new.from_email, new.to_recipients, new.cc_recipients) then
    return null;
  end if;
  return new;
end $$;

-- tickets made from mail by the sync: same rule (a person filing one by hand still decides)
create or replace function public.ticket_mail_known()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  by_hand boolean := coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-ticket-by-hand', '') = '1';
  t uuid := coalesce(new.tenant_id, public.current_tenant());
begin
  if by_hand then return new; end if;
  if new.source = 'email' and coalesce(new.requester_email, '') <> '' then
    if coalesce(public.mail_view_rules(t)->>'keep', 'clients') = 'crm' then
      if not public.mail_is_known(t, new.requester_email) then return null; end if;
    elsif not public.mail_is_client(t, new.requester_email) then
      return null;
    end if;
  end if;
  return new;
end $$;

-- what is already stored: shown only when it passes
drop policy if exists mail_known_only on public.ticket_mail_messages;
create policy mail_known_only on public.ticket_mail_messages as restrictive for select to authenticated
  using (public.mail_row_allowed(tenant_id, direction, from_email, to_recipients, cc_recipients));

/* ---------- 2. whose mail can this person see? ---------- */
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

  -- the mail of a ticket assigned to them
  if p_ticket is not null and exists (select 1 from tracking_tasks where id = p_ticket and assignee_id = me) then return true; end if;

  select m.owner_id into owner_id from ticket_mailboxes m where m.id = p_mailbox;
  if owner_id = me then return true; end if;

  rules := public.mail_view_rules(p_tenant);
  lvl := my.lvl;
  r := coalesce(rules->'users'->(me::text), rules->'roles'->lvl, rules->'depts'->coalesce(my.department, ''), rules->'everyone');
  if r is null or jsonb_typeof(r) <> 'object' then
    -- nothing saved: managers their department, the rest their own; shared mailboxes for all
    r := case when lvl ~ 'manager' or my.role ~ 'manager' then '{"see":"department","shared":true}'::jsonb else '{"see":"own","shared":true}'::jsonb end;
  end if;
  see := coalesce(r->>'see', 'own');

  if owner_id is null then return coalesce((r->>'shared')::boolean, true); end if;
  if see = 'all' then return true; end if;
  if see = 'own' then return false; end if;
  select department into od from profiles where id = owner_id;
  if see = 'department' then return my.department is not null and od = my.department; end if;
  if see = 'teams' then return od is not null and r->'depts' ? od; end if;
  if see = 'people' then return r->'people' ? owner_id::text; end if;
  return false;
end $$;
grant execute on function public.mail_can_see(uuid, uuid, uuid) to authenticated;

drop policy if exists mail_whose on public.ticket_mail_messages;
create policy mail_whose on public.ticket_mail_messages as restrictive for select to authenticated
  using (public.mail_can_see(tenant_id, mailbox_id, ticket_id));

commit;
