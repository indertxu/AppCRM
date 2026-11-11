-- =====================================================================
-- 130_connected_google_ads.sql — Base · Settings › Integrations: Google Ads
-- =====================================================================
-- connected_assets.kind may be 'gads_customer': a Google Ads account a Google
-- login can reach (external_id = customer id, digits only; extra: currency,
-- manager, test_account, last-30-days cost / clicks / impressions / conversions).
-- Additive (check widened).
-- =====================================================================
alter table public.connected_assets drop constraint if exists connected_assets_kind_check;
alter table public.connected_assets add constraint connected_assets_kind_check
  check (kind in ('facebook_page', 'instagram', 'ad_account', 'linkedin_org', 'mailrelay_group', 'whatsapp_number', 'gads_customer'));
notify pgrst, 'reload schema';
