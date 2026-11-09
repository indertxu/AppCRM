-- 116_mail_known_only.sql  ·  GDPR: the app only keeps and shows e-mail from people it already has.
--
-- An e-mail is "known" when its address (incoming: the sender; outgoing: any recipient) is
--   · a contact's e-mail, a company's e-mail, a colleague's (profiles) e-mail, or in a client's own contact list, or
--   · at a company's own domain: its website or e-mail domain, or the domain of a contact linked to a company
--     (never a public one such as gmail.com, and never linkedin.com & co. taken from a website field).
--
-- 1) mail_is_known(tenant, email) — the one check, also called by the outlook-sync edge function before it reads a message.
-- 2) A trigger on ticket_mail_messages: a message that isn't known is never stored (whatever stores it).
--    A trigger on tracking_tasks: no ticket is opened from the e-mail of someone unknown.
-- 3) A restrictive policy: a stored message whose people are no longer in the CRM (a contact or company removed) is not shown.
-- Additive only (functions, indexes, triggers, a policy). The purge of what was stored before is 117_purge_unknown_mail.sql.

create or replace function public.mail_domain(p text) returns text
language sql immutable parallel safe as $$
  select case when d ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then d end
  from (select lower(split_part(trim(coalesce(p, '')), '@', 2)) as d) x
$$;

-- "https://www.acme.com/en/about" → "acme.com"; social / site-builder hosts give nothing
create or replace function public.site_domain(p text) returns text
language sql immutable parallel safe as $$
  select case when d ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'
               and d !~ '(^|\.)(linkedin|facebook|instagram|twitter|x|youtube|google|wixsite|wix|wordpress|blogspot|github|medium|tiktok|godaddysites|squarespace|webnode|business\.site)\.[a-z.]+$'
              then d end
  from (select split_part(split_part(split_part(
          regexp_replace(regexp_replace(lower(trim(coalesce(p, ''))), '^[a-z]+://', ''), '^www\.', ''),
          '/', 1), ':', 1), '?', 1) as d) x
$$;

-- the same list as the edge functions' CS_PUBLIC
create or replace function public.mail_public_domain(d text) returns boolean
language sql immutable parallel safe as $$
  select coalesce(d, '') ~* '^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|web|zoho|yandex|telefonica|movistar|orange|vodafone|terra|ono|t-online|libero|free|laposte|wanadoo|qq|163)\.'
$$;

create or replace function public.mail_is_known(p_tenant uuid, p_email text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  d text := public.mail_domain(p_email);
begin
  if p_tenant is null or d is null then return false; end if;
  -- a signed-in user may only ask about their own company
  if coalesce(auth.role(), '') = 'authenticated' and p_tenant is distinct from public.current_tenant() then return false; end if;

  if exists (select 1 from contacts  where tenant_id = p_tenant and lower(email) = e) then return true; end if;
  if exists (select 1 from profiles  where tenant_id = p_tenant and lower(email) = e) then return true; end if;
  if exists (select 1 from companies where tenant_id = p_tenant and lower(email) = e) then return true; end if;
  if exists (select 1 from clients cl
               cross join lateral jsonb_array_elements(case when jsonb_typeof(cl.contacts) = 'array' then cl.contacts else '[]'::jsonb end) x
             where cl.tenant_id = p_tenant and lower(trim(x->>'email')) = e) then return true; end if;

  if public.mail_public_domain(d) then return false; end if;
  if exists (select 1 from companies where tenant_id = p_tenant and public.site_domain(website) = d) then return true; end if;
  if exists (select 1 from companies where tenant_id = p_tenant and public.mail_domain(email) = d) then return true; end if;
  if exists (select 1 from contacts c where c.tenant_id = p_tenant and public.mail_domain(c.email) = d
               and exists (select 1 from company_contacts cc where cc.contact_id = c.id)) then return true; end if;
  return false;
end $$;

-- one stored message: incoming → its sender; outgoing → any of its recipients
create or replace function public.mail_row_known(p_tenant uuid, p_dir text, p_from text, p_to jsonb, p_cc jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select case when p_dir = 'out' then exists (
      select 1 from jsonb_array_elements(
        (case when jsonb_typeof(p_to) = 'array' then p_to else '[]'::jsonb end) ||
        (case when jsonb_typeof(p_cc) = 'array' then p_cc else '[]'::jsonb end)) r
      where public.mail_is_known(p_tenant, case when jsonb_typeof(r) = 'string' then r #>> '{}' else r->>'email' end))
    else public.mail_is_known(p_tenant, p_from) end
$$;

revoke all on function public.mail_is_known(uuid, text) from public, anon;
revoke all on function public.mail_row_known(uuid, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.mail_is_known(uuid, text) to authenticated, service_role;
grant execute on function public.mail_row_known(uuid, text, text, jsonb, jsonb) to authenticated, service_role;

create index if not exists ix116_contacts_mail_domain   on public.contacts  (public.mail_domain(email));
create index if not exists ix116_companies_site_domain  on public.companies (public.site_domain(website));
create index if not exists ix116_companies_mail_domain  on public.companies (public.mail_domain(email));
create index if not exists ix116_companies_email_lower  on public.companies (lower(email));
create index if not exists ix116_profiles_email_lower   on public.profiles  (lower(email));

-- 2) never stored
create or replace function public.mail_keep_known() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.mail_row_known(new.tenant_id, new.direction, new.from_email, new.to_recipients, new.cc_recipients) then
    return null;   -- dropped quietly: not in the CRM
  end if;
  return new;
end $$;

create or replace trigger trg116_mail_keep_known
  before insert on public.ticket_mail_messages
  for each row execute function public.mail_keep_known();

create or replace function public.ticket_mail_known() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'email' and coalesce(new.requester_email, '') <> ''
     and not public.mail_is_known(new.tenant_id, new.requester_email) then
    return null;
  end if;
  return new;
end $$;

create or replace trigger trg116_ticket_mail_known
  before insert on public.tracking_tasks
  for each row execute function public.ticket_mail_known();

-- 3) never shown
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ticket_mail_messages' and policyname = 'mail_known_only') then
    create policy mail_known_only on public.ticket_mail_messages as restrictive for select to authenticated
      using (public.mail_row_known(tenant_id, direction, from_email, to_recipients, cc_recipients));
  end if;
end $$;
