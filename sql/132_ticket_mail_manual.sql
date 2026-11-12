-- 132 · A ticket made from an e-mail is no longer dropped by mistake.
-- 116's trigger (trg116_ticket_mail_known) skips an e-mail ticket whose sender isn't in the CRM — a filter meant for
-- the automatic mail sync. Two problems:
--  1. Triggers run in name order, so it ran before trg_set_tenant: tenant_id was still empty when the app created the
--     row, mail_is_known() answered "unknown" for everyone, and every ticket created from Tickets › Inbox vanished
--     (the app said "Cannot coerce the result to a single JSON object"). Now the tenant is the one the row will get.
--  2. A person filing an Inbox e-mail by hand decided it's a ticket, known sender or not: the app marks that request
--     with the header x-ticket-by-hand: 1, and then the row is always kept.
create or replace function public.ticket_mail_known()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  by_hand boolean := coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-ticket-by-hand', '') = '1';
begin
  if by_hand then return new; end if;
  if new.source = 'email' and coalesce(new.requester_email, '') <> ''
     and not public.mail_is_known(coalesce(new.tenant_id, public.current_tenant()), new.requester_email) then
    return null;
  end if;
  return new;
end $$;
