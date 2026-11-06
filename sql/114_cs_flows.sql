-- =====================================================================
-- 114 · ENTERPRISE · Customer success: sequences with branches, e-mail tracking, replies, tasks
--   cs_sequences.flow        the steps as a tree: e-mails, "wait and check" branches
--                            (replied / opened, no reply / not opened), tasks for the client's owners, end
--                            (null: the old straight list in steps, as before)
--   cs_sequence_runs         node (where each client is in the tree), wait_until (a check's deadline),
--                            last_log_id (the e-mail the check looks at)
--   cs_email_log             opened_at/opens, clicked_at/clicks, replied_at, links (the only addresses a
--                            tracked click may go to), node, from_address
--   cs_run_events            what happened to each client: e-mail sent, branch taken, task made, end
--   cs_mailbox_sync          where the reading of each team mailbox (e.g. CS Iberia) got to
--   cs_track()               the open pixel / tracked link of the cs-engine function writes here
--   cs_mark_replies()        a client's e-mail that came in after ours = a reply
--   cs_send_due()            the hourly job now calls the cs-engine function
-- Safe to run more than once.
-- =====================================================================
alter table public.cs_sequences add column if not exists flow jsonb;

alter table public.cs_sequence_runs add column if not exists node text;
alter table public.cs_sequence_runs add column if not exists wait_until timestamptz;
alter table public.cs_sequence_runs add column if not exists last_log_id uuid;

alter table public.cs_email_log add column if not exists opened_at timestamptz;
alter table public.cs_email_log add column if not exists opens integer not null default 0;
alter table public.cs_email_log add column if not exists clicked_at timestamptz;
alter table public.cs_email_log add column if not exists clicks integer not null default 0;
alter table public.cs_email_log add column if not exists replied_at timestamptz;
alter table public.cs_email_log add column if not exists links text[];
alter table public.cs_email_log add column if not exists node text;
alter table public.cs_email_log add column if not exists from_address text;
create index if not exists cs_email_log_seq on public.cs_email_log (sequence_id, node);
create index if not exists cs_email_log_waiting on public.cs_email_log (tenant_id, sent_at) where replied_at is null and status = 'sent';

create table if not exists public.cs_run_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  run_id uuid references public.cs_sequence_runs(id) on delete cascade,
  sequence_id uuid references public.cs_sequences(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  node text,
  kind text not null,          -- email · branch · task · end · error
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists cs_run_events_seq on public.cs_run_events (sequence_id, at desc);
create index if not exists cs_run_events_client on public.cs_run_events (client_id, at desc);

create table if not exists public.cs_mailbox_sync (
  address text primary key,
  tenant_id uuid,
  read_after timestamptz,
  scanned integer not null default 0,
  logged integer not null default 0,
  last_run_at timestamptz,
  last_error text,
  via text
);

do $$ declare t text; begin
  foreach t in array array['cs_run_events', 'cs_mailbox_sync'] loop
    if to_regprocedure('public.set_tenant_id()') is not null then
      execute format('drop trigger if exists trg_set_tenant on public.%I', t);
      execute format('create trigger trg_set_tenant before insert on public.%I for each row execute function set_tenant_id()', t);
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_all on public.%I', t);
    execute format('create policy tenant_all on public.%I for all to authenticated using (tenant_id = public.current_tenant()) with check (tenant_id is null or tenant_id = public.current_tenant())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- an open (the 1×1 picture loaded) or a click (only to an address that is in that e-mail)
create or replace function public.cs_track(p_log uuid, p_kind text, p_url text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l record;
begin
  select id, links into l from public.cs_email_log where id = p_log and status = 'sent';
  if l.id is null then return jsonb_build_object('ok', false); end if;
  if p_kind = 'open' then
    update public.cs_email_log set opened_at = coalesce(opened_at, now()), opens = opens + 1 where id = p_log;
    return jsonb_build_object('ok', true);
  elsif p_kind = 'click' then
    if p_url is null or not (p_url = any(coalesce(l.links, '{}'))) then return jsonb_build_object('ok', false); end if;
    update public.cs_email_log set clicked_at = coalesce(clicked_at, now()), clicks = clicks + 1, opened_at = coalesce(opened_at, now()), opens = greatest(opens, 1) where id = p_log;
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false);
end $$;
revoke all on function public.cs_track(uuid, text, text) from public, anon, authenticated;

-- a reply: an e-mail from that client (one of the people it went to, or anyone at the client) after ours
create or replace function public.cs_mark_replies(p_tenant uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with hit as (
    select l.id, min(c.contacted_at) at
      from public.cs_email_log l
      join public.client_contacts_log c on c.client_id = l.client_id and c.direction = 'in' and c.contacted_at > l.sent_at
     where l.status = 'sent' and l.replied_at is null and l.sent_at > now() - interval '60 days'
       and (p_tenant is null or l.tenant_id = p_tenant)
     group by l.id
  )
  update public.cs_email_log l set replied_at = hit.at, opened_at = coalesce(l.opened_at, hit.at) from hit where l.id = hit.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.cs_mark_replies(uuid) from public, anon, authenticated;

-- the hourly job: the cs-engine function (sends, reads the team mailboxes, follows the branches)
create or replace function public.cs_send_due()
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare k text; u text; a text;
begin
  select key, functions_url, anon_key into k, u, a from public.cs_cron_key where id = 1;
  if k is null or u is null or a is null then return null; end if;
  return net.http_post(
    url := u || '/cs-engine',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || a, 'x-cs-cron', k),
    body := jsonb_build_object('action', 'cs_run_all'),
    timeout_milliseconds := 150000);
end $$;
