-- =====================================================================
-- 86_platform_admin.sql — the superadmin console: usage, data and costs
--
--  * platform_page_visits   one row per page visit in the app: active
--                           seconds, requests and bytes it moved (written by
--                           the app itself, read only by superadmins)
--  * platform_ai_usage      every AI call (proposal-ai): model and tokens
--  * platform_usage_daily   daily snapshot of what each company stores:
--                           rows and bytes per table, files per bucket
--  * platform_settings      the cost model (prices, fixed costs, revenue)
--  * sa_refresh_usage()     takes today's snapshot (also daily via pg_cron)
--  * sa_dashboard(days)     everything the console's overview needs, in one call
--  * sa_tenant(id, days)    one company: users (with e-mail, last sign-in),
--                           pages, tables, files, AI, history
-- Everything is superadmin-only. Applied with the Supabase MCP.
-- =====================================================================

-- ---------- who wrote it: always the caller, in their own company ----------
create or replace function public.sa_stamp_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.user_id := coalesce(auth.uid(), new.user_id);
  new.tenant_id := coalesce(public.current_tenant(), new.tenant_id);
  return new;
end $$;
revoke all on function public.sa_stamp_owner() from public, anon, authenticated;  -- a trigger, not an endpoint

-- ---------- page visits ----------
create table if not exists public.platform_page_visits (
  id             bigint generated always as identity primary key,
  tenant_id      uuid,
  user_id        uuid not null,
  page           text not null,
  started_at     timestamptz not null default now(),
  active_seconds integer not null default 0 check (active_seconds between 0 and 86400),
  requests       integer not null default 0 check (requests >= 0),
  bytes          bigint  not null default 0 check (bytes >= 0),
  created_at     timestamptz not null default now()
);
create index if not exists platform_page_visits_tenant_idx on public.platform_page_visits (tenant_id, started_at desc);
create index if not exists platform_page_visits_user_idx   on public.platform_page_visits (user_id, started_at desc);
drop trigger if exists platform_page_visits_owner on public.platform_page_visits;
create trigger platform_page_visits_owner before insert on public.platform_page_visits
  for each row execute function public.sa_stamp_owner();
alter table public.platform_page_visits enable row level security;
drop policy if exists "ppv insert own" on public.platform_page_visits;
create policy "ppv insert own" on public.platform_page_visits for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "ppv superadmin read" on public.platform_page_visits;
create policy "ppv superadmin read" on public.platform_page_visits for select to authenticated using (public.is_superadmin());

-- ---------- AI usage ----------
create table if not exists public.platform_ai_usage (
  id            bigint generated always as identity primary key,
  tenant_id     uuid,
  user_id       uuid not null,
  feature       text not null default 'other',
  model         text not null,
  input_tokens  integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  at            timestamptz not null default now()
);
create index if not exists platform_ai_usage_tenant_idx on public.platform_ai_usage (tenant_id, at desc);
drop trigger if exists platform_ai_usage_owner on public.platform_ai_usage;
create trigger platform_ai_usage_owner before insert on public.platform_ai_usage
  for each row execute function public.sa_stamp_owner();
alter table public.platform_ai_usage enable row level security;
drop policy if exists "pai insert own" on public.platform_ai_usage;
create policy "pai insert own" on public.platform_ai_usage for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "pai superadmin read" on public.platform_ai_usage;
create policy "pai superadmin read" on public.platform_ai_usage for select to authenticated using (public.is_superadmin());

-- ---------- daily storage snapshot ----------
-- tenant_id 00000000-… = not a company's (shared catalogues, backups without a tenant, system)
create table if not exists public.platform_usage_daily (
  day       date not null,
  tenant_id uuid not null,
  kind      text not null check (kind in ('table', 'file')),
  name      text not null,
  rows      bigint not null default 0,
  bytes     bigint not null default 0,
  primary key (day, tenant_id, kind, name)
);
alter table public.platform_usage_daily enable row level security;
drop policy if exists "pud superadmin read" on public.platform_usage_daily;
create policy "pud superadmin read" on public.platform_usage_daily for select to authenticated using (public.is_superadmin());

-- ---------- cost model ----------
create table if not exists public.platform_settings (
  id         integer primary key default 1 check (id = 1),
  costs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (1) on conflict (id) do nothing;
alter table public.platform_settings enable row level security;
drop policy if exists "ps superadmin all" on public.platform_settings;
create policy "ps superadmin all" on public.platform_settings for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- ---------- the snapshot ----------
-- Rows per company come from counting; bytes are each company's share of the
-- table's real on-disk size (heap + indexes + toast), split by the size of its rows.
create or replace function public.sa_refresh_usage_run()
returns integer language plpgsql security definer set search_path = public, storage as $$
declare
  r record;
  n integer := 0;
  zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  delete from public.platform_usage_daily where day = current_date;

  for r in
    select c.oid, c.relname,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as tenanted
      from pg_class c join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    if r.tenanted then
      execute format($q$
        with t as (
          select coalesce(x.tenant_id::text::uuid, %L::uuid) as tid, count(*) as n, sum(pg_column_size(x.*))::numeric as b
            from public.%I x group by 1
        ), s as (select sum(b) as sb from t)
        insert into public.platform_usage_daily (day, tenant_id, kind, name, rows, bytes)
        select current_date, t.tid, 'table', %L, t.n,
               case when s.sb > 0 then round(%s::numeric * t.b / s.sb)::bigint else 0 end
          from t, s
        on conflict (day, tenant_id, kind, name) do update set rows = excluded.rows, bytes = excluded.bytes
      $q$, zero, r.relname, r.relname, pg_total_relation_size(r.oid));
      -- an empty table still takes disk: book it to the platform
      if not exists (select 1 from public.platform_usage_daily where day = current_date and kind = 'table' and name = r.relname) then
        insert into public.platform_usage_daily values (current_date, zero, 'table', r.relname, 0, pg_total_relation_size(r.oid));
      end if;
    else
      insert into public.platform_usage_daily
      values (current_date, zero, 'table', r.relname,
              greatest((select reltuples from pg_class where oid = r.oid), 0)::bigint, pg_total_relation_size(r.oid))
      on conflict (day, tenant_id, kind, name) do update set rows = excluded.rows, bytes = excluded.bytes;
    end if;
    n := n + 1;
  end loop;

  -- files: every object's path starts with its company's id
  insert into public.platform_usage_daily (day, tenant_id, kind, name, rows, bytes)
  select current_date,
         coalesce(tn.id, zero),
         'file', o.bucket_id, count(*), coalesce(sum((o.metadata ->> 'size')::bigint), 0)
    from storage.objects o
    left join public.tenants tn on tn.id::text = split_part(o.name, '/', 1)
   group by 2, 4
  on conflict (day, tenant_id, kind, name) do update set rows = excluded.rows, bytes = excluded.bytes;

  -- keep a bit more than a year
  delete from public.platform_usage_daily where day < current_date - 400;
  return n;
end $$;
revoke all on function public.sa_refresh_usage_run() from public, anon, authenticated;

create or replace function public.sa_refresh_usage()
returns jsonb language plpgsql security definer set search_path = public as $$
declare n integer; t0 timestamptz := clock_timestamp();
begin
  if not public.is_superadmin() then raise exception 'Only a superadmin can do this'; end if;
  n := public.sa_refresh_usage_run();
  return jsonb_build_object('tables', n, 'day', current_date, 'ms', round(extract(epoch from clock_timestamp() - t0) * 1000));
end $$;
revoke all on function public.sa_refresh_usage() from public, anon;
grant execute on function public.sa_refresh_usage() to authenticated;

-- ---------- the overview ----------
create or replace function public.sa_dashboard(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public, auth, storage as $$
declare
  d integer := greatest(1, least(coalesce(p_days, 30), 365));
  since timestamptz := date_trunc('day', now()) - make_interval(days => d - 1);
  snap date;
  zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if not public.is_superadmin() then raise exception 'Only a superadmin can read this'; end if;
  select max(day) into snap from public.platform_usage_daily;

  return jsonb_build_object(
    'generated_at', now(),
    'days', d,
    'since', since,
    'snapshot_day', snap,
    'db_bytes', pg_database_size(current_database()),
    'file_bytes', (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects),
    'file_count', (select count(*) from storage.objects),
    'auth_users', (select count(*) from auth.users),
    'mau', (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
    'settings', coalesce((select costs from public.platform_settings where id = 1), '{}'::jsonb),
    'tenants', coalesce((
      select jsonb_agg(x order by x.name) from (
        select t.id, t.name, t.active, t.max_users, t.created_at,
          (select count(*) from public.profiles p where p.tenant_id = t.id and not coalesce(p.is_superadmin, false)) as users,
          (select count(*) from public.profiles p where p.tenant_id = t.id and p.active is false) as deactivated,
          (select count(*) from public.profiles p join auth.users u on u.id = p.id
            where p.tenant_id = t.id and u.last_sign_in_at > now() - interval '30 days') as signed_in_30d,
          (select count(distinct v.user_id) from public.platform_page_visits v where v.tenant_id = t.id and v.started_at >= since) as active_users,
          greatest(
            (select max(v.started_at) from public.platform_page_visits v where v.tenant_id = t.id),
            (select max(u.last_sign_in_at) from public.profiles p join auth.users u on u.id = p.id where p.tenant_id = t.id)
          ) as last_seen,
          coalesce(v.visits, 0) as visits, coalesce(v.seconds, 0) as seconds,
          coalesce(v.requests, 0) as requests, coalesce(v.bytes, 0) as bytes,
          coalesce(s.db_rows, 0) as db_rows, coalesce(s.db_bytes, 0) as db_bytes,
          coalesce(s.file_count, 0) as file_count, coalesce(s.file_bytes, 0) as file_bytes,
          coalesce(a.calls, 0) as ai_calls, coalesce(a.tin, 0) as ai_in, coalesce(a.tout, 0) as ai_out,
          (select count(*) from public.crm_history h where h.tenant_id = t.id and h.at >= since and h.at <= now() and h.actor is not null) as changes
        from public.tenants t
        left join lateral (
          select count(*) as visits, sum(active_seconds) as seconds, sum(requests) as requests, sum(bytes) as bytes
            from public.platform_page_visits v where v.tenant_id = t.id and v.started_at >= since
        ) v on true
        left join lateral (
          select sum(rows) filter (where kind = 'table') as db_rows, sum(bytes) filter (where kind = 'table') as db_bytes,
                 sum(rows) filter (where kind = 'file') as file_count, sum(bytes) filter (where kind = 'file') as file_bytes
            from public.platform_usage_daily u where u.day = snap and u.tenant_id = t.id
        ) s on true
        left join lateral (
          select count(*) as calls, sum(input_tokens) as tin, sum(output_tokens) as tout
            from public.platform_ai_usage a where a.tenant_id = t.id and a.at >= since
        ) a on true
      ) x), '[]'::jsonb),
    -- what isn't a company's: shared tables, backups, system
    'unassigned', (select jsonb_build_object(
        'db_rows', coalesce(sum(rows) filter (where kind = 'table'), 0), 'db_bytes', coalesce(sum(bytes) filter (where kind = 'table'), 0),
        'file_count', coalesce(sum(rows) filter (where kind = 'file'), 0), 'file_bytes', coalesce(sum(bytes) filter (where kind = 'file'), 0))
      from public.platform_usage_daily where day = snap and tenant_id = zero),
    'daily', coalesce((
      select jsonb_agg(x order by x.day) from (
        select (v.started_at at time zone 'UTC')::date as day, v.tenant_id,
               count(*) as visits, sum(v.active_seconds) as seconds, sum(v.requests) as requests, sum(v.bytes) as bytes,
               count(distinct v.user_id) as users
          from public.platform_page_visits v where v.started_at >= since
         group by 1, 2) x), '[]'::jsonb),
    'changes_daily', coalesce((
      select jsonb_agg(x order by x.day) from (
        select (h.at at time zone 'UTC')::date as day, h.tenant_id, count(*) as changes, count(distinct h.actor) as users
          from public.crm_history h where h.at >= since and h.at <= now() and h.actor is not null
         group by 1, 2) x), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(x) from (
        select v.tenant_id, v.page, count(*) as visits, sum(v.active_seconds) as seconds,
               sum(v.requests) as requests, sum(v.bytes) as bytes, count(distinct v.user_id) as users
          from public.platform_page_visits v where v.started_at >= since
         group by 1, 2) x), '[]'::jsonb),
    'ai', coalesce((
      select jsonb_agg(x) from (
        select a.tenant_id, a.model, a.feature, count(*) as calls, sum(a.input_tokens) as tin, sum(a.output_tokens) as tout
          from public.platform_ai_usage a where a.at >= since
         group by 1, 2, 3) x), '[]'::jsonb),
    'storage_history', coalesce((
      select jsonb_agg(x order by x.day) from (
        select u.day, u.tenant_id,
               sum(u.bytes) filter (where u.kind = 'table') as db_bytes, sum(u.bytes) filter (where u.kind = 'file') as file_bytes
          from public.platform_usage_daily u where u.day >= (since at time zone 'UTC')::date - 1
         group by 1, 2) x), '[]'::jsonb),
    'tables_top', coalesce((
      select jsonb_agg(x) from (
        select u.name, sum(u.rows) as rows, sum(u.bytes) as bytes
          from public.platform_usage_daily u where u.day = snap and u.kind = 'table'
         group by 1 order by 3 desc limit 20) x), '[]'::jsonb)
  );
end $$;
revoke all on function public.sa_dashboard(integer) from public, anon;
grant execute on function public.sa_dashboard(integer) to authenticated;

-- ---------- one company ----------
create or replace function public.sa_tenant(p_tenant uuid, p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public, auth, storage as $$
declare
  d integer := greatest(1, least(coalesce(p_days, 30), 365));
  since timestamptz := date_trunc('day', now()) - make_interval(days => d - 1);
  snap date;
begin
  if not public.is_superadmin() then raise exception 'Only a superadmin can read this'; end if;
  select max(day) into snap from public.platform_usage_daily where tenant_id = p_tenant;

  return jsonb_build_object(
    'tenant', (select to_jsonb(t) from public.tenants t where t.id = p_tenant),
    'days', d, 'since', since, 'snapshot_day', snap,
    'users', coalesce((
      select jsonb_agg(x order by x.seconds desc, x.email) from (
        select p.id, coalesce(u.email, p.email) as email, p.first_name, p.last_name, p.role, p.job_title, p.department,
               coalesce(p.active, true) as active, coalesce(p.is_superadmin, false) as is_superadmin,
               u.created_at, u.last_sign_in_at, u.email_confirmed_at is not null as confirmed,
               coalesce(v.visits, 0) as visits, coalesce(v.seconds, 0) as seconds,
               coalesce(v.requests, 0) as requests, coalesce(v.bytes, 0) as bytes, v.last_seen,
               (select v2.page from public.platform_page_visits v2 where v2.user_id = p.id and v2.started_at >= since
                 group by v2.page order by sum(v2.active_seconds) desc limit 1) as top_page,
               coalesce(a.calls, 0) as ai_calls, coalesce(a.tin, 0) as ai_in, coalesce(a.tout, 0) as ai_out,
               (select count(*) from public.crm_history h where h.actor = p.id and h.at >= since and h.at <= now()) as changes
          from public.profiles p
          left join auth.users u on u.id = p.id
          left join lateral (
            select count(*) as visits, sum(active_seconds) as seconds, sum(requests) as requests, sum(bytes) as bytes, max(started_at) as last_seen
              from public.platform_page_visits v where v.user_id = p.id and v.started_at >= since
          ) v on true
          left join lateral (
            select count(*) as calls, sum(input_tokens) as tin, sum(output_tokens) as tout
              from public.platform_ai_usage a where a.user_id = p.id and a.at >= since
          ) a on true
         where p.tenant_id = p_tenant) x), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(x order by x.seconds desc) from (
        select v.page, count(*) as visits, sum(v.active_seconds) as seconds, sum(v.requests) as requests,
               sum(v.bytes) as bytes, count(distinct v.user_id) as users
          from public.platform_page_visits v where v.tenant_id = p_tenant and v.started_at >= since
         group by 1) x), '[]'::jsonb),
    'user_pages', coalesce((
      select jsonb_agg(x) from (
        select v.user_id, v.page, sum(v.active_seconds) as seconds, count(*) as visits
          from public.platform_page_visits v where v.tenant_id = p_tenant and v.started_at >= since
         group by 1, 2) x), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(x order by x.day) from (
        select (v.started_at at time zone 'UTC')::date as day, count(*) as visits, sum(v.active_seconds) as seconds,
               sum(v.requests) as requests, sum(v.bytes) as bytes, count(distinct v.user_id) as users
          from public.platform_page_visits v where v.tenant_id = p_tenant and v.started_at >= since
         group by 1) x), '[]'::jsonb),
    'changes', coalesce((
      select jsonb_agg(x order by x.n desc) from (
        select h.entity, h.action, count(*) as n, count(distinct h.actor) as users
          from public.crm_history h where h.tenant_id = p_tenant and h.at >= since and h.at <= now() and h.actor is not null
         group by 1, 2) x), '[]'::jsonb),
    'changes_daily', coalesce((
      select jsonb_agg(x order by x.day) from (
        select (h.at at time zone 'UTC')::date as day, count(*) as changes, count(distinct h.actor) as users
          from public.crm_history h where h.tenant_id = p_tenant and h.at >= since and h.at <= now() and h.actor is not null
         group by 1) x), '[]'::jsonb),
    'tables', coalesce((
      select jsonb_agg(x order by x.bytes desc) from (
        select u.name, u.rows, u.bytes from public.platform_usage_daily u
         where u.day = snap and u.tenant_id = p_tenant and u.kind = 'table' and (u.rows > 0 or u.bytes > 0)) x), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(x order by x.bytes desc) from (
        select u.name as bucket, u.rows as count, u.bytes from public.platform_usage_daily u
         where u.day = snap and u.tenant_id = p_tenant and u.kind = 'file') x), '[]'::jsonb),
    'storage_history', coalesce((
      select jsonb_agg(x order by x.day) from (
        select u.day, sum(u.bytes) filter (where u.kind = 'table') as db_bytes, sum(u.bytes) filter (where u.kind = 'file') as file_bytes
          from public.platform_usage_daily u where u.tenant_id = p_tenant and u.day >= (since at time zone 'UTC')::date - 1
         group by 1) x), '[]'::jsonb),
    'ai', coalesce((
      select jsonb_agg(x) from (
        select a.model, a.feature, count(*) as calls, sum(a.input_tokens) as tin, sum(a.output_tokens) as tout
          from public.platform_ai_usage a where a.tenant_id = p_tenant and a.at >= since
         group by 1, 2) x), '[]'::jsonb)
  );
end $$;
revoke all on function public.sa_tenant(uuid, integer) from public, anon;
grant execute on function public.sa_tenant(uuid, integer) to authenticated;

-- fast "what changed, by whom, when" for the activity numbers
create index if not exists crm_history_tenant_at_idx on public.crm_history (tenant_id, at desc);
create index if not exists crm_history_actor_at_idx on public.crm_history (actor, at desc);

-- ---------- every day at 03:15 UTC ----------
create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'sa-usage-daily';
  perform cron.schedule('sa-usage-daily', '15 3 * * *', 'select public.sa_refresh_usage_run()');
end $$;

-- first snapshot now
select public.sa_refresh_usage_run();
