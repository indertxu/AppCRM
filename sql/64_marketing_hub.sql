-- =====================================================================
-- 64_marketing_hub.sql — Marketing hub: e-mail tracking, social posts, AI
-- =====================================================================
-- Run 20_marketing.sql first. Nothing is deleted. Safe to run more than once.
--
-- 1. marketing_sends gets what happened after "sent":
--      opened_at / open_count, clicked_at / click_count / last_click_url,
--      replied_at, bounced_at, unsubscribed_at
--    marketing_events keeps every open / click / reply / bounce / unsubscribe.
--    mk_track() records them — called by the edge function manage-users
--    (public links: the open pixel, tracked links, the unsubscribe page).
-- 2. marketing_campaigns gets a preheader, tracking switches and the AI brief.
-- 3. marketing_social_accounts  the company's pages / profiles per network
--    marketing_posts            social posts: text per network, pictures,
--                               schedule, status and results
-- =====================================================================
begin;
set local search_path = public, extensions;

create or replace function pg_temp.copy_policies(src text, dst text) returns int language plpgsql as $$
declare p record; n int := 0;
begin
  execute format('alter table public.%I enable row level security', dst);
  for p in select * from pg_policies where schemaname = 'public' and tablename = src loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst and policyname = p.policyname) then n := n + 1; continue; end if;
    begin
      execute format('create policy %I on public.%I as %s for %s to %s %s %s',
        p.policyname, dst, p.permissive, p.cmd, array_to_string(p.roles, ', '),
        case when p.qual is not null then 'using (' || p.qual || ')' else '' end,
        case when p.with_check is not null then 'with check (' || p.with_check || ')' else '' end);
      n := n + 1;
    exception when others then
      raise notice 'policy % not copied to %: %', p.policyname, dst, sqlerrm;
    end;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst) then
    execute format('create policy tenant_all on public.%I for all to authenticated using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', dst);
  end if;
  return n;
end $$;

create or replace function pg_temp.tenant_table(t text, with_trigger boolean default true) returns void language plpgsql as $$
begin
  if with_trigger then
    execute format('drop trigger if exists trg_set_tenant on public.%I', t);
    execute format('create trigger trg_set_tenant before insert on public.%I for each row execute function set_tenant_id()', t);
  end if;
  perform pg_temp.copy_policies('marketing_campaigns', t);
  execute format('grant select, insert, update, delete on public.%I to authenticated', t);
end $$;

-- ---------- 1. what happened after "sent" ----------
alter table public.marketing_sends add column if not exists opened_at timestamptz;
alter table public.marketing_sends add column if not exists open_count int not null default 0;
alter table public.marketing_sends add column if not exists clicked_at timestamptz;
alter table public.marketing_sends add column if not exists click_count int not null default 0;
alter table public.marketing_sends add column if not exists last_click_url text;
alter table public.marketing_sends add column if not exists replied_at timestamptz;
alter table public.marketing_sends add column if not exists bounced_at timestamptz;
alter table public.marketing_sends add column if not exists unsubscribed_at timestamptz;

create table if not exists public.marketing_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  campaign_id uuid references public.marketing_campaigns(id) on delete cascade,
  send_id uuid references public.marketing_sends(id) on delete cascade,
  kind text not null check (kind in ('open', 'click', 'reply', 'bounce', 'unsubscribe')),
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists marketing_events_campaign on public.marketing_events (campaign_id, kind, created_at);
-- no tenant trigger: rows are written by mk_track() with the send's company
select pg_temp.tenant_table('marketing_events', false);

/* Records an open / click / unsubscribe of one recipient. Public links reach it
   through the edge function (service role). A click only counts — and only
   returns the address to go to — when the link is really in that campaign. */
create or replace function public.mk_track(p_send uuid, p_kind text, p_url text default null, p_ua text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s record; c record; v_ok boolean := true; v_uid uuid; v_body text;
begin
  select * into s from public.marketing_sends where id = p_send;
  if not found then return jsonb_build_object('ok', false); end if;
  select * into c from public.marketing_campaigns where id = s.campaign_id;

  if p_kind = 'open' then
    update public.marketing_sends set open_count = open_count + 1, opened_at = coalesce(opened_at, now()) where id = p_send;
  elsif p_kind = 'click' then
    v_body := replace(coalesce(c.body_html, ''), '&amp;', '&');
    v_ok := p_url is not null and p_url ~* '^https?://' and position(p_url in v_body) > 0;
    if not v_ok then return jsonb_build_object('ok', false); end if;
    -- a click means it was opened too (pictures are often blocked)
    update public.marketing_sends set click_count = click_count + 1, clicked_at = coalesce(clicked_at, now()),
      last_click_url = p_url, opened_at = coalesce(opened_at, now()), open_count = greatest(open_count, 1) where id = p_send;
  elsif p_kind = 'unsubscribe' then
    update public.marketing_sends set unsubscribed_at = coalesce(unsubscribed_at, now()) where id = p_send;
    if not exists (select 1 from public.marketing_unsubscribes where tenant_id is not distinct from s.tenant_id and lower(email) = lower(s.email)) then
      insert into public.marketing_unsubscribes (email, reason, source) values (lower(s.email), 'Unsubscribe link', 'link') returning id into v_uid;
      update public.marketing_unsubscribes set tenant_id = s.tenant_id where id = v_uid;
    end if;
    if s.contact_id is not null then update public.contacts set marketing_opt_out = true where id = s.contact_id; end if;
  else
    return jsonb_build_object('ok', false);
  end if;

  insert into public.marketing_events (tenant_id, campaign_id, send_id, kind, url, user_agent)
  values (s.tenant_id, s.campaign_id, s.id, p_kind, p_url, left(p_ua, 300));
  return jsonb_build_object('ok', true, 'url', p_url, 'email', s.email);
end $$;
revoke all on function public.mk_track(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mk_track(uuid, text, text, text) to service_role;

-- ---------- 2. campaigns ----------
alter table public.marketing_campaigns add column if not exists preheader text;
alter table public.marketing_campaigns add column if not exists track_opens boolean not null default true;
alter table public.marketing_campaigns add column if not exists track_clicks boolean not null default true;
alter table public.marketing_campaigns add column if not exists ai_brief text;
alter table public.marketing_campaigns add column if not exists tags text[] not null default '{}';

-- ---------- 3. social ----------
create table if not exists public.marketing_social_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  network text not null,                 -- linkedin | instagram | facebook | x | tiktok | youtube | threads | other
  name text not null,                    -- "Empower — company page"
  handle text,                           -- @empower / the page URL
  kind text not null default 'page',     -- page | profile | group
  status text not null default 'manual' check (status in ('manual', 'connected', 'expired')),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
select pg_temp.tenant_table('marketing_social_accounts');

create table if not exists public.marketing_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  title text,                            -- internal name
  body text not null default '',         -- the main text
  -- per network: { "linkedin": { "text": "…", "account_id": uuid }, "instagram": { … } }
  variants jsonb not null default '{}'::jsonb,
  networks text[] not null default '{}',
  -- [{ "url": "…", "kind": "image" | "video", "alt": "…" }]
  media jsonb not null default '[]'::jsonb,
  link_url text,
  status text not null default 'draft' check (status in ('idea', 'draft', 'scheduled', 'published', 'failed', 'cancelled')),
  scheduled_at timestamptz,
  published_at timestamptz,
  -- per network: { "linkedin": { "url": "…", "impressions": n, "likes": n, "comments": n, "shares": n, "clicks": n } }
  results jsonb not null default '{}'::jsonb,
  series text,                           -- a series / campaign the post belongs to
  ai_brief text,
  source text not null default 'manual', -- manual | import | ai
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketing_posts_when on public.marketing_posts (tenant_id, scheduled_at);
select pg_temp.tenant_table('marketing_posts');

notify pgrst, 'reload schema';
commit;

select
  (select count(*) from information_schema.columns where table_name = 'marketing_sends' and column_name in ('opened_at', 'clicked_at', 'replied_at', 'bounced_at')) as tracking_columns,
  (select count(*) from pg_policies where tablename in ('marketing_events', 'marketing_posts', 'marketing_social_accounts')) as new_rules,
  to_regprocedure('public.mk_track(uuid, text, text, text)') is not null as track_function;
