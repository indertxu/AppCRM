-- =====================================================================
-- 80_renewal_deals.sql — an ended contract goes back to Sales as a renewal deal
-- =====================================================================
-- When a client's subscription reaches its end date (and doesn't renew by
-- itself), the app opens a deal for it in your renewal pipeline — the
-- pipeline whose name contains "renew" (e.g. "Renewals") — with the people of
-- the deal that sold it. These two columns make sure each signed product is
-- sent only once:
--   · renewal_claimed_at: when the app took it (two people opening Clients at
--     the same time can't both create the deal),
--   · renewal_tracking_id: the renewal deal it became.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;

alter table public.client_products add column if not exists renewal_claimed_at timestamptz;
alter table public.client_products add column if not exists renewal_tracking_id uuid references public.trackings(id) on delete set null;
create index if not exists client_products_renewal on public.client_products (renewal_tracking_id) where renewal_tracking_id is not null;

notify pgrst, 'reload schema';
commit;

select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'client_products'
          and column_name in ('renewal_claimed_at', 'renewal_tracking_id')) as columns_ready,
       (select string_agg(name, ', ') from public.pipelines where name ~* 'renew') as renewal_pipelines;
