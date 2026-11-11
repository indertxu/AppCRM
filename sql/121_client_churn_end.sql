-- 121_client_churn_end.sql  ·  A client can churn on a later day (its contract's end).
--
-- · client_products.ends_on: a running product stops on that day. Marking a client churned with a future date
--   (and "stop its running products") sets it, so the products count as recurring until then; marking it active
--   again clears it. A churn today or before still sets status 'cancelled' (+ ends_on).
-- · client_products_status_chk also allows 'paused' and 'ended' (the product status picker offers them).
--   (Marking a client churned used to write status 'churned', which the check refused.)
-- Applied 2026-11-10.

alter table public.client_products add column if not exists ends_on date;

alter table public.client_products drop constraint if exists client_products_status_chk;
alter table public.client_products add constraint client_products_status_chk
  check (status = any (array['active','expired','cancelled','renewed','paused','ended']));
