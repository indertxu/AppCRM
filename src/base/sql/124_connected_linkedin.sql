-- =====================================================================
-- 124_connected_linkedin.sql — Base · Settings › Integrations: LinkedIn
-- =====================================================================
-- connected_accounts.provider may be 'linkedin'; connected_assets.kind may be
-- 'linkedin_org' (a LinkedIn company page the member administers — read once
-- LinkedIn approves the Community Management API).
-- Additive (checks widened, nothing removed).
-- =====================================================================
alter table public.connected_accounts drop constraint if exists connected_accounts_provider_check;
alter table public.connected_accounts add constraint connected_accounts_provider_check check (provider in ('google', 'microsoft', 'meta', 'linkedin'));
alter table public.connected_assets drop constraint if exists connected_assets_kind_check;
alter table public.connected_assets add constraint connected_assets_kind_check check (kind in ('facebook_page', 'instagram', 'ad_account', 'linkedin_org'));
notify pgrst, 'reload schema';
