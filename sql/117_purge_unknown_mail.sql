-- 117_purge_unknown_mail.sql  ·  GDPR: delete the e-mail stored before 116 from people who aren't in the CRM.
-- Needs 116_mail_known_only.sql. Run it in the Supabase SQL editor (as postgres).
-- Since 116 these messages are already hidden from everyone and new ones are never stored; this removes the old copies.
-- See what goes first:
--   select from_email, subject, received_at from public.ticket_mail_messages m
--    where not public.mail_row_known(m.tenant_id, m.direction, m.from_email, m.to_recipients, m.cc_recipients)
--    order by received_at desc;

delete from public.ticket_mail_messages m
 where not public.mail_row_known(m.tenant_id, m.direction, m.from_email, m.to_recipients, m.cc_recipients);
