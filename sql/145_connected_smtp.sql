-- =====================================================================
-- 145 · Connected accounts: mailboxes reached by SMTP (IONOS Mail and
--       any other host with a user + password)            (Enterprise)
--
-- connected_accounts.provider  + 'smtp'
-- connected_accounts.settings  jsonb — not secret: { host, port, label }
--                              (the password lives in connected_account_tokens.access_token,
--                               which only the service role reads — like Mailrelay's API key)
-- Kept by the edge function marketing-hub (actions smtp_connect / smtp_check, mail_send).
-- =====================================================================
alter table public.connected_accounts drop constraint if exists connected_accounts_provider_check;
alter table public.connected_accounts add constraint connected_accounts_provider_check
  check (provider = any (array['google', 'microsoft', 'meta', 'linkedin', 'mailrelay', 'smtp']));
alter table public.connected_accounts add column if not exists settings jsonb not null default '{}'::jsonb;
