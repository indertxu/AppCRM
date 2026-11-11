-- 122_upsell_in_contract.sql  ·  An upsell signed into an existing contract.
-- client_products.contract_tracking_id: the deal whose contract this product joins (an upsell, or a product added by hand),
-- instead of counting as a contract of its own. Empty: the product's own deal is its contract (as before).
-- Applied 2026-11-10.
alter table public.client_products add column if not exists contract_tracking_id uuid references public.trackings(id) on delete set null;
create index if not exists ix122_client_products_contract on public.client_products (contract_tracking_id) where contract_tracking_id is not null;
