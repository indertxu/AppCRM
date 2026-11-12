-- =====================================================================
-- 133_connected_google_analytics.sql — Base · Settings › Integrations: Google Analytics
-- =====================================================================
-- connected_assets.kind may be 'ga_property': a Google Analytics 4 property a
-- Google login can read (external_id = property id; extra: account name, time
-- zone, last-28-days users / sessions / key events, top sources).
-- Additive (check widened).
-- =====================================================================
alter table public.connected_assets drop constraint if exists connected_assets_kind_check;
alter table public.connected_assets add constraint connected_assets_kind_check
  check (kind in ('facebook_page', 'instagram', 'ad_account', 'linkedin_org', 'mailrelay_group', 'whatsapp_number', 'gads_customer', 'ga_property'));
notify pgrst, 'reload schema';
