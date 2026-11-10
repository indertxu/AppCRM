-- =====================================================================
-- 125_connected_mailrelay.sql — Base · Settings › Integrations: Mailrelay
-- =====================================================================
-- connected_accounts.provider may be 'mailrelay' (an API-key account: email =
-- the account address, e.g. acme.ipzmarketing.com; the key lives in
-- connected_account_tokens.access_token, service role only).
-- connected_assets.kind may be 'mailrelay_group' (a Mailrelay group of subscribers).
-- Additive (checks widened, nothing removed).
-- =====================================================================
alter table public.connected_accounts drop constraint if exists connected_accounts_provider_check;
alter table public.connected_accounts add constraint connected_accounts_provider_check check (provider in ('google', 'microsoft', 'meta', 'linkedin', 'mailrelay'));
alter table public.connected_assets drop constraint if exists connected_assets_kind_check;
alter table public.connected_assets add constraint connected_assets_kind_check check (kind in ('facebook_page', 'instagram', 'ad_account', 'linkedin_org', 'mailrelay_group'));
notify pgrst, 'reload schema';
