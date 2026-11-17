-- =====================================================================
-- 149 · Marketing › Workflows
--
-- A workflow starts by itself when something happens and then runs steps, like the
-- customer-success sequences: e-mails (from Marketing › E-mail templates), "wait and check"
-- branches (replied · opened, no reply · didn't open), tasks for the team, end.
--
--   mk_workflows         name, status (draft / active / paused), trigger, flow (the steps), sender
--      trigger = { kind: 'campaign', campaign_id, event: sent|opened|clicked|replied|not_opened, days, backfill }
--              | { kind: 'post', post_id | null (any), networks: [..] | null, list_id | null, backfill }
--              | { kind: 'form', form_id | null (any), backfill }
--   mk_workflow_runs     one per person (or per post) that started it: where it is (node), when next
--   mk_workflow_events   what each run did (log)
--   marketing_sends      a workflow's e-mails are sends too (opens, clicks, unsubscribes, replies tracked the
--                        same way): campaign_id may now be empty; workflow_id / wf_run / wf_node / links added
--   mk_track()           a click counts when the link is one of the send's own links (links) too
--   mk_workflows_due()   every 5 minutes (pg_cron) asks marketing-hub ("wf_due") to move them along
--
-- Nothing is dropped or renamed. Safe to run twice.
-- =====================================================================

create table if not exists public.mk_workflows (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid,
  name           text not null default 'Untitled workflow',
  status         text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  trigger        jsonb not null default '{}'::jsonb,
  flow           jsonb not null default '[]'::jsonb,
  sender_account uuid references public.connected_accounts (id) on delete set null,
  from_address   text,
  owner_id       uuid,
  activated_at   timestamptz,
  last_run_at    timestamptz,
  last_error     text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists mk_workflows_tenant on public.mk_workflows (tenant_id);
create index if not exists mk_workflows_active on public.mk_workflows (status) where status = 'active';

create table if not exists public.mk_workflow_runs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid,
  workflow_id  uuid not null references public.mk_workflows (id) on delete cascade,
  source       text not null,
  contact_id   uuid references public.contacts (id) on delete set null,
  company_id   uuid references public.companies (id) on delete set null,
  email        text,
  name         text,
  merge        jsonb not null default '{}'::jsonb,
  node         text not null default '0',
  status       text not null default 'active' check (status in ('active', 'done', 'stopped', 'failed')),
  next_at      timestamptz default now(),
  wait_until   timestamptz,
  last_send_id uuid,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workflow_id, source)
);
create index if not exists mk_workflow_runs_due on public.mk_workflow_runs (next_at) where status = 'active';
create index if not exists mk_workflow_runs_wf on public.mk_workflow_runs (workflow_id, status);
create index if not exists mk_workflow_runs_tenant on public.mk_workflow_runs (tenant_id);

create table if not exists public.mk_workflow_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  workflow_id uuid not null references public.mk_workflows (id) on delete cascade,
  run_id      uuid references public.mk_workflow_runs (id) on delete cascade,
  node        text,
  kind        text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists mk_workflow_events_wf on public.mk_workflow_events (workflow_id, created_at desc);
create index if not exists mk_workflow_events_tenant on public.mk_workflow_events (tenant_id);

-- a workflow's e-mails are marketing sends without a campaign
alter table public.marketing_sends alter column campaign_id drop not null;
alter table public.marketing_sends add column if not exists workflow_id uuid references public.mk_workflows (id) on delete cascade;
alter table public.marketing_sends add column if not exists wf_run uuid references public.mk_workflow_runs (id) on delete set null;
alter table public.marketing_sends add column if not exists wf_node text;
alter table public.marketing_sends add column if not exists links text[];
create index if not exists marketing_sends_workflow on public.marketing_sends (workflow_id) where workflow_id is not null;

do $$ declare t text; begin
  foreach t in array array['mk_workflows', 'mk_workflow_runs', 'mk_workflow_events'] loop
    execute format('drop trigger if exists trg_set_tenant on public.%I', t);
    execute format('create trigger trg_set_tenant before insert on public.%I for each row execute function public.set_tenant_id()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I for all to authenticated using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()))', t);
  end loop;
end $$;

-- a click is real when the link is in the campaign's text, or one of the send's own links (workflow e-mails)
create or replace function public.mk_track(p_send uuid, p_kind text, p_url text default null, p_ua text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare s record; c record; v_ok boolean := true; v_uid uuid; v_body text;
begin
  select * into s from public.marketing_sends where id = p_send;
  if not found then return jsonb_build_object('ok', false); end if;
  select * into c from public.marketing_campaigns where id = s.campaign_id;

  if p_kind = 'open' then
    update public.marketing_sends set open_count = open_count + 1, opened_at = coalesce(opened_at, now()) where id = p_send;
  elsif p_kind = 'click' then
    v_body := replace(coalesce(c.body_html, ''), '&amp;', '&');
    v_ok := p_url is not null and p_url ~* '^https?://' and (position(p_url in v_body) > 0 or p_url = any(coalesce(s.links, '{}'::text[])));
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
end $function$;
revoke all on function public.mk_track(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mk_track(uuid, text, text, text) to service_role;

-- every 5 minutes: when a workflow is on, marketing-hub moves them along
create or replace function public.mk_workflows_due()
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare k text; u text; a text;
begin
  if not exists (select 1 from public.mk_workflows where status = 'active') then return null; end if;
  select key, functions_url, anon_key into k, u, a from public.cs_cron_key where id = 1;
  if k is null or u is null or a is null then return null; end if;
  return net.http_post(
    url := u || '/marketing-hub',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || a, 'x-cs-cron', k),
    body := jsonb_build_object('action', 'wf_due'),
    timeout_milliseconds := 150000);
end $$;
revoke all on function public.mk_workflows_due() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'marketing-workflows') then perform cron.unschedule('marketing-workflows'); end if;
  perform cron.schedule('marketing-workflows', '2-59/5 * * * *', 'select public.mk_workflows_due()');
end $$;
