-- =====================================================================
-- 82_renewal_pipeline.sql — you choose the pipeline renewals go to
-- =====================================================================
-- Settings › Client pipelines › a pipeline › "Use for renewals": ended client
-- contracts come back to Sales in that pipeline, as renewal deals (see
-- 80_renewal_deals.sql). Until one is chosen, a pipeline called "…renew…" is used.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;

alter table public.pipelines add column if not exists is_renewal boolean not null default false;

notify pgrst, 'reload schema';
commit;

select string_agg(name, ', ') filter (where is_renewal) as renewal_pipeline from public.pipelines;
