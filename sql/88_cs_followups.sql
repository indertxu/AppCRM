-- =====================================================================
-- 88_cs_followups.sql — Customer success: priorities and automatic e-mail follow-ups
--
--   · clients.cs_priority (high / medium / low) and, in cs_settings, how often
--     each priority should hear from us (priority_cadence, in days)
--   · cs_email_templates — e-mail blueprints (subject, styled HTML, attachments)
--   · cs_sequences       — which blueprints go out, in what order, after how many
--                          days, to which clients (priority, type, health, picked ones)
--   · cs_sequence_runs   — each client's place in each sequence (paused, done…)
--   · cs_email_log       — every e-mail sent (or not, and why)
--   · bucket "cs-files"  — the attachments, one folder per company
--   · cs_generate_contact_tasks — the cadence follows the priority, and a manual
--                          run only touches your own company
--   · an hourly job that asks the outlook-sync function to send what is due
-- Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

-- ---------- priorities ----------
alter table public.clients add column if not exists cs_priority text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'clients_cs_priority_chk') then
    alter table public.clients add constraint clients_cs_priority_chk check (cs_priority is null or cs_priority in ('high', 'medium', 'low'));
  end if;
end $$;
alter table public.cs_settings add column if not exists priority_cadence jsonb not null default '{"high": 14, "medium": 30, "low": 60}'::jsonb;

-- ---------- blueprints ----------
create table if not exists public.cs_email_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null default 'Untitled e-mail',
  subject text not null default '',
  body_html text not null default '',
  html text not null default '',
  design jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- sequences ----------
create table if not exists public.cs_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null default 'Untitled follow-up',
  active boolean not null default false,
  audience jsonb not null default '{}'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  start_mode text not null default 'now' check (start_mode in ('now', 'before_renewal')),
  start_days integer not null default 60,
  repeat boolean not null default false,
  recipients text not null default 'main' check (recipients in ('main', 'all', 'billing')),
  sender text not null default 'owner' check (sender in ('owner', 'me')),
  log_contact boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cs_sequence_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  sequence_id uuid not null references public.cs_sequences(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  step integer not null default 0,
  status text not null default 'active' check (status in ('active', 'paused', 'done', 'excluded')),
  next_at timestamptz,
  cycle integer not null default 0,
  last_sent_at timestamptz,
  to_emails text[],
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  unique (sequence_id, client_id)
);
create index if not exists cs_sequence_runs_due on public.cs_sequence_runs (status, next_at);

create table if not exists public.cs_email_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  sequence_id uuid references public.cs_sequences(id) on delete set null,
  run_id uuid references public.cs_sequence_runs(id) on delete set null,
  client_id uuid references public.clients(id) on delete cascade,
  template_id uuid references public.cs_email_templates(id) on delete set null,
  step integer,
  to_emails text[],
  subject text,
  status text not null default 'sent' check (status in ('sent', 'failed', 'skipped', 'test')),
  error text,
  sent_by uuid,
  sent_at timestamptz not null default now()
);
create index if not exists cs_email_log_client on public.cs_email_log (client_id, sent_at desc);
create index if not exists cs_email_log_tenant on public.cs_email_log (tenant_id, sent_at desc);

-- every row belongs to the company of whoever makes it; each company sees its own
do $$ declare t text; begin
  foreach t in array array['cs_email_templates', 'cs_sequences', 'cs_sequence_runs', 'cs_email_log'] loop
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

-- ---------- attachments: a private bucket, one folder per company ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('cs-files', 'cs-files', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
drop policy if exists "cs-files: read own company"   on storage.objects;
drop policy if exists "cs-files: upload own company" on storage.objects;
drop policy if exists "cs-files: delete own company" on storage.objects;
create policy "cs-files: read own company" on storage.objects for select to authenticated
  using (bucket_id = 'cs-files' and (storage.foldername(name))[1] = public.current_tenant()::text);
create policy "cs-files: upload own company" on storage.objects for insert to authenticated
  with check (bucket_id = 'cs-files' and (storage.foldername(name))[1] = public.current_tenant()::text);
create policy "cs-files: delete own company" on storage.objects for delete to authenticated
  using (bucket_id = 'cs-files' and (storage.foldername(name))[1] = public.current_tenant()::text);

-- ---------- follow-up tasks: the cadence follows the priority; a manual run is your company only ----------
create or replace function public.cs_generate_contact_tasks(p_tenant uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; has_tenant boolean; scope uuid;
begin
  -- signed in: your own company, whatever is asked; the scheduler (no user) may name one or do all
  scope := coalesce(case when auth.uid() is not null then public.current_tenant() end, p_tenant);
  if auth.uid() is not null and scope is null then return 0; end if;
  has_tenant := exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tracking_tasks' and column_name = 'tenant_id');
  for r in
    select c.id as client_id, c.tenant_id, c.name,
           coalesce(c.contact_cadence_days,
                    nullif(s.priority_cadence ->> c.cs_priority, '')::int,
                    s.default_cadence_days, 30) as cadence,
           (select max(l.contacted_at) from public.client_contacts_log l where l.client_id = c.id) as last_at,
           (select o.profile_id from public.client_cs_owners o where o.client_id = c.id order by o.is_primary desc, o.created_at limit 1) as owner
    from public.clients c
    left join public.cs_settings s on s.tenant_id = c.tenant_id
    where (scope is null or c.tenant_id = scope)
      and coalesce(s.auto_tasks, true)
  loop
    continue when r.owner is null;
    continue when r.last_at is not null and r.last_at > now() - make_interval(days => r.cadence);
    continue when exists (
      select 1 from public.tracking_tasks t
      where t.external_ref = 'cs-contact:' || r.client_id
        and coalesce(t.done, false) = false and coalesce(t.stage, 'open') not in ('resolved', 'closed'));
    insert into public.tracking_tasks (tracking_id, title, kind, priority, status, progress, due_at,
                                       client_id, assignee_id, external_ref, source, created_by)
    values (null,
            'Get in touch with ' || r.name || case when r.last_at is null then ' (no contact logged yet)'
              else ' (' || extract(day from now() - r.last_at)::int || ' days since last contact)' end,
            'quick', 'high', 'todo', 0, now() + interval '2 days',
            r.client_id, r.owner, 'cs-contact:' || r.client_id, 'manual', r.owner);
    if has_tenant then
      execute 'update public.tracking_tasks set tenant_id = $1 where external_ref = $2 and tenant_id is null'
        using r.tenant_id, 'cs-contact:' || r.client_id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- the hourly sender: pg_net calls outlook-sync with a key only the database and the function know ----------
create extension if not exists pg_net with schema extensions;
-- functions_url: https://<project>.supabase.co/functions/v1 · anon_key: the project's anon (public) key — set them once:
--   update public.cs_cron_key set functions_url = '…', anon_key = '…';
create table if not exists public.cs_cron_key (id int primary key default 1 check (id = 1), key text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  functions_url text, anon_key text);
alter table public.cs_cron_key add column if not exists functions_url text;
alter table public.cs_cron_key add column if not exists anon_key text;
alter table public.cs_cron_key enable row level security;   -- no policy: only the service role reads it
revoke all on public.cs_cron_key from anon, authenticated;
insert into public.cs_cron_key (id) values (1) on conflict (id) do nothing;

create or replace function public.cs_send_due()
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare k text; u text; a text;
begin
  select key, functions_url, anon_key into k, u, a from public.cs_cron_key where id = 1;
  if k is null or u is null or a is null then return null; end if;
  return net.http_post(
    url := u || '/outlook-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || a, 'x-cs-cron', k),
    body := jsonb_build_object('action', 'cs_run_all'),
    timeout_milliseconds := 120000);
end $$;
revoke all on function public.cs_send_due() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'cs-followups-hourly') then perform cron.unschedule('cs-followups-hourly'); end if;
  perform cron.schedule('cs-followups-hourly', '7 * * * *', 'select public.cs_send_due()');
end $$;

notify pgrst, 'reload schema';
commit;
