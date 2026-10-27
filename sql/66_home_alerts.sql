-- =====================================================================
-- 66_home_alerts.sql — the alerts at the top of Home
-- =====================================================================
-- user_alerts: one row per person per thing that happened to them. The
-- database writes them by itself (triggers), so every screen that changes
-- these tables produces the alert, whoever made the change:
--   • a task or ticket assigned to you (assignee, or added as a person on it)
--   • a reply / message on a task or ticket you're on
--   • a note on a client that mentions you
--   • a meeting / booking you're invited to, moved, cancelled or taken off
--   • your invitees accepting or declining
-- Nobody is alerted about what they did themselves.
-- Each person only reads, marks as read and clears their own alerts.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.user_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  user_id uuid not null,
  kind text not null,          -- task_assigned | message | mention | invite | invite_moved | invite_cancelled | invite_removed | invite_accepted | invite_declined
  title text not null,
  body text,
  ref_type text,               -- task | invite | entry | client
  ref_id uuid,
  actor_id uuid,
  at timestamptz,              -- when the thing happens (a meeting's start)
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  done_at timestamptz          -- cleared from Home
);
create index if not exists user_alerts_mine on public.user_alerts (user_id, created_at desc);

alter table public.user_alerts enable row level security;
drop policy if exists "alerts: read own" on public.user_alerts;
drop policy if exists "alerts: update own" on public.user_alerts;
drop policy if exists "alerts: delete own" on public.user_alerts;
create policy "alerts: read own" on public.user_alerts for select to authenticated using (user_id = auth.uid());
create policy "alerts: update own" on public.user_alerts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "alerts: delete own" on public.user_alerts for delete to authenticated using (user_id = auth.uid());
grant select, update, delete on public.user_alerts to authenticated;

-- live updates on Home
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_alerts') then
    execute 'alter publication supabase_realtime add table public.user_alerts';
  end if;
end $$;

/* One alert; never to the person who did it. */
create or replace function public.alert_push(p_user uuid, p_tenant uuid, p_kind text, p_title text, p_body text, p_ref_type text, p_ref_id uuid, p_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user = auth.uid() then return; end if;
  insert into public.user_alerts (tenant_id, user_id, kind, title, body, ref_type, ref_id, actor_id, at)
  values (p_tenant, p_user, p_kind, left(coalesce(p_title, ''), 300), left(p_body, 500), p_ref_type, p_ref_id, auth.uid(), p_at);
end $$;
revoke all on function public.alert_push(uuid, uuid, text, text, text, text, uuid, timestamptz) from public, anon, authenticated;

create or replace function pg_temp.has_table(t text) returns boolean language sql as $$ select to_regclass('public.' || t) is not null $$;

/* ---------- tasks & tickets ---------- */
create or replace function public.alert_task_assigned() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new);
begin
  if new.assignee_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.assignee_id is not distinct from new.assignee_id then return new; end if;
  perform public.alert_push(new.assignee_id, (j->>'tenant_id')::uuid, 'task_assigned', coalesce(j->>'title', 'A task'),
    case when j->>'due_at' is not null then 'due ' || to_char((j->>'due_at')::timestamptz, 'DD Mon') end, 'task', new.id, null);
  return new;
end $$;

create or replace function public.alert_task_person() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); t record;
begin
  if coalesce(j->>'kind', 'employee') <> 'employee' or (j->>'employee_id') is null or coalesce(j->>'item_type', 'task') <> 'task' then return new; end if;
  select id, title, to_jsonb(tt)->>'tenant_id' as tenant into t from public.tracking_tasks tt where id = (j->>'item_id')::uuid;
  if not found then return new; end if;
  perform public.alert_push((j->>'employee_id')::uuid, t.tenant::uuid, 'task_assigned', coalesce(t.title, 'A task'), 'you were added to it', 'task', t.id, null);
  return new;
end $$;

create or replace function public.alert_task_message() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); t jsonb; who uuid; preview text;
begin
  select to_jsonb(tt) into t from public.tracking_tasks tt where id = (j->>'task_id')::uuid;
  if t is null then return new; end if;
  preview := left(btrim(regexp_replace(coalesce(j->>'body', ''), '<[^>]+>|\s+', ' ', 'g')), 160);
  for who in
    select distinct u from (
      select (t->>'assignee_id')::uuid as u
      union select (t->>'created_by')::uuid
      union select (to_jsonb(a)->>'employee_id')::uuid from public.tracking_assignees a
        where to_jsonb(a)->>'item_id' = t->>'id' and coalesce(to_jsonb(a)->>'item_type', 'task') = 'task'
    ) s where u is not null and u is distinct from (j->>'author_id')::uuid
  loop
    perform public.alert_push(who, (t->>'tenant_id')::uuid, 'message', coalesce(t->>'title', 'A task'), preview, 'task', (t->>'id')::uuid, null);
  end loop;
  return new;
end $$;

/* ---------- client notes that mention someone ---------- */
create or replace function public.alert_note_mention() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); m text; cname text;
begin
  if jsonb_typeof(j->'mentions') <> 'array' then return new; end if;
  select name into cname from public.clients where id = (j->>'client_id')::uuid;
  for m in select jsonb_array_elements_text(j->'mentions') loop
    begin
      perform public.alert_push(m::uuid, (j->>'tenant_id')::uuid, 'mention', coalesce(cname, 'A client'),
        left(regexp_replace(coalesce(j->>'body', ''), '@\[([^\]]+)\]\([^)]*\)', '@\1', 'g'), 160), 'client', (j->>'client_id')::uuid, null);
    exception when invalid_text_representation then null;
    end;
  end loop;
  return new;
end $$;

/* ---------- invitations ---------- */
create or replace function public.alert_entry_at(e jsonb) returns timestamptz language sql stable as $$
  select case when e->>'entry_date' is null then null
    else ((e->>'entry_date')::date + make_interval(mins => coalesce((e->>'start_min')::int, 0)))::timestamp at time zone 'Europe/Madrid' end
$$;

create or replace function public.alert_invite() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb; e jsonb;
begin
  if tg_op = 'DELETE' then j := to_jsonb(old); else j := to_jsonb(new); end if;
  select to_jsonb(ce) into e from public.calendar_entries ce where id = (j->>'entry_id')::uuid;
  if tg_op = 'INSERT' then
    if e is null then return new; end if;
    perform public.alert_push((j->>'invitee_id')::uuid, (coalesce(j->>'tenant_id', e->>'tenant_id'))::uuid, 'invite', coalesce(e->>'title', 'A meeting'), j->>'message', 'invite', (j->>'id')::uuid, public.alert_entry_at(e));
    return new;
  elsif tg_op = 'UPDATE' then
    if (old.status is distinct from new.status) and new.status in ('accepted', 'declined') then
      perform public.alert_push((j->>'organiser_id')::uuid, (coalesce(j->>'tenant_id', e->>'tenant_id'))::uuid, 'invite_' || new.status, coalesce(e->>'title', 'Your meeting'), null, 'entry', (j->>'entry_id')::uuid, public.alert_entry_at(e));
    end if;
    return new;
  else
    -- the entry itself being deleted is announced by alert_entry_gone (with its title)
    if e is null or coalesce(j->>'status', '') = 'declined' then return old; end if;
    perform public.alert_push((j->>'invitee_id')::uuid, (coalesce(j->>'tenant_id', e->>'tenant_id'))::uuid, 'invite_removed', coalesce(e->>'title', 'A meeting'), null, 'entry', (j->>'entry_id')::uuid, public.alert_entry_at(e));
    return old;
  end if;
end $$;

create or replace function public.alert_entry_gone() returns trigger language plpgsql security definer set search_path = public as $$
declare e jsonb := to_jsonb(old); i record;
begin
  for i in select invitee_id, status from public.entry_invites where entry_id = old.id loop
    if coalesce(i.status, '') <> 'declined' then
      perform public.alert_push(i.invitee_id, (e->>'tenant_id')::uuid, 'invite_cancelled', coalesce(e->>'title', 'A meeting'), null, 'entry', old.id, public.alert_entry_at(e));
    end if;
  end loop;
  return old;
end $$;

create or replace function public.alert_entry_moved() returns trigger language plpgsql security definer set search_path = public as $$
declare e jsonb := to_jsonb(new); i record;
begin
  if old.entry_date is not distinct from new.entry_date and old.start_min is not distinct from new.start_min then return new; end if;
  for i in select invitee_id, status from public.entry_invites where entry_id = new.id loop
    if coalesce(i.status, '') <> 'declined' then
      perform public.alert_push(i.invitee_id, (e->>'tenant_id')::uuid, 'invite_moved', coalesce(e->>'title', 'A meeting'), null, 'entry', new.id, public.alert_entry_at(e));
    end if;
  end loop;
  return new;
end $$;

do $$ begin
  if pg_temp.has_table('tracking_tasks') then
    drop trigger if exists trg_alert_task_assigned on public.tracking_tasks;
    create trigger trg_alert_task_assigned after insert or update of assignee_id on public.tracking_tasks for each row execute function public.alert_task_assigned();
  end if;
  if pg_temp.has_table('tracking_assignees') then
    drop trigger if exists trg_alert_task_person on public.tracking_assignees;
    create trigger trg_alert_task_person after insert on public.tracking_assignees for each row execute function public.alert_task_person();
  end if;
  if pg_temp.has_table('tracking_task_updates') then
    drop trigger if exists trg_alert_task_message on public.tracking_task_updates;
    create trigger trg_alert_task_message after insert on public.tracking_task_updates for each row execute function public.alert_task_message();
  end if;
  if pg_temp.has_table('client_notes') then
    drop trigger if exists trg_alert_note_mention on public.client_notes;
    create trigger trg_alert_note_mention after insert on public.client_notes for each row execute function public.alert_note_mention();
  end if;
  if pg_temp.has_table('entry_invites') then
    drop trigger if exists trg_alert_invite on public.entry_invites;
    create trigger trg_alert_invite after insert or update of status or delete on public.entry_invites for each row execute function public.alert_invite();
  end if;
  if pg_temp.has_table('calendar_entries') then
    drop trigger if exists trg_alert_entry_gone on public.calendar_entries;
    create trigger trg_alert_entry_gone before delete on public.calendar_entries for each row execute function public.alert_entry_gone();
    drop trigger if exists trg_alert_entry_moved on public.calendar_entries;
    create trigger trg_alert_entry_moved after update of entry_date, start_min on public.calendar_entries for each row execute function public.alert_entry_moved();
  end if;
end $$;

-- start with what's already waiting: invitations nobody has answered yet
insert into public.user_alerts (tenant_id, user_id, kind, title, body, ref_type, ref_id, actor_id, at, created_at)
select (to_jsonb(ce)->>'tenant_id')::uuid, i.invitee_id, 'invite', coalesce(ce.title, 'A meeting'), i.message, 'invite', i.id, i.organiser_id,
       public.alert_entry_at(to_jsonb(ce)), coalesce(i.created_at, now())
  from public.entry_invites i join public.calendar_entries ce on ce.id = i.entry_id
 where i.status = 'pending' and ce.entry_date >= current_date
   and not exists (select 1 from public.user_alerts a where a.ref_type = 'invite' and a.ref_id = i.id);

notify pgrst, 'reload schema';
commit;

select count(*) as alerts_waiting from public.user_alerts where done_at is null;
