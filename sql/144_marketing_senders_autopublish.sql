-- =====================================================================
-- 144 · Marketing: send campaigns from a connected mailbox; publish
--       scheduled LinkedIn posts by themselves            (Enterprise)
--
-- marketing_campaigns.sender_account  the Gmail / Outlook account (Settings ›
--     Integrations, connected_accounts) a campaign is sent from; null = the
--     person's own Outlook connection (outlook-sync), as before.
-- marketing_posts.auto_accounts       { "linkedin": <connected_accounts.id> } —
--     a scheduled post with it is published by itself when its time comes
--     (edge function marketing-hub, action social_due, every 5 minutes).
-- mk_social_due()                     called by pg_cron; only calls the edge
--     function when a post is actually due (cs_cron_key holds the URL + keys).
-- =====================================================================
alter table public.marketing_campaigns
  add column if not exists sender_account uuid references public.connected_accounts(id) on delete set null;

alter table public.marketing_posts
  add column if not exists auto_accounts jsonb not null default '{}'::jsonb;

create or replace function public.mk_social_due()
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare k text; u text; a text;
begin
  if not exists (
    select 1 from public.marketing_posts
     where status = 'scheduled' and scheduled_at <= now()
       and auto_accounts ? 'linkedin' and 'linkedin' = any(networks)
       and coalesce(results->'linkedin'->>'auto_at', '') = ''
       and coalesce(results->'linkedin'->>'auto_error', '') = ''
  ) then return null; end if;
  select key, functions_url, anon_key into k, u, a from public.cs_cron_key where id = 1;
  if k is null or u is null or a is null then return null; end if;
  return net.http_post(
    url := u || '/marketing-hub',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || a, 'x-cs-cron', k),
    body := jsonb_build_object('action', 'social_due'),
    timeout_milliseconds := 120000);
end $$;
revoke all on function public.mk_social_due() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'marketing-social-due') then perform cron.unschedule('marketing-social-due'); end if;
  perform cron.schedule('marketing-social-due', '*/5 * * * *', 'select public.mk_social_due()');
end $$;
