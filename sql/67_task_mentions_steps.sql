-- =====================================================================
-- 67_task_mentions_steps.sql — tasks: who hears about what
-- =====================================================================
-- Needs 66_home_alerts.sql (the alerts table and alert_push).
-- Adds alerts (Home, the bell) for:
--   • being added as a watcher of a task / ticket ("added you to")
--   • being @mentioned in a task's description or in a comment / note
--   • being given a step of a task ("gave you a step on")
-- A person who just got an alert about a task (in the last 2 minutes)
-- isn't alerted again for being added as a watcher of it, so mentioning
-- or giving a step to someone (which also adds them) is one alert.
-- Steps keep who does them in the checklist itself: {id, text, done, who}.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

do $$ begin
  if to_regprocedure('public.alert_push(uuid, uuid, text, text, text, text, uuid, timestamptz)') is null then
    raise exception 'Run 66_home_alerts.sql first.';
  end if;
end $$;

/* The people @mentioned in a text: "@[Name](employee:<uuid>)". */
create or replace function public.alert_mentions(txt text) returns setof uuid language sql immutable as $$
  select distinct (m[1])::uuid
    from regexp_matches(coalesce(txt, ''), '@\[[^\]]*\]\(employee:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)', 'g') as m
$$;

/* Mentions as plain names, for the alert's preview line. */
create or replace function public.alert_plain(txt text, n int default 160) returns text language sql immutable as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(txt, ''), '@\[([^\]]+)\]\([^)]*\)', '@\1', 'g'), '<[^>]+>|\s+', ' ', 'g')), n)
$$;

/* Already told about this, just now? */
create or replace function public.alert_recent(p_user uuid, p_ref uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_alerts where user_id = p_user and ref_id = p_ref and created_at > now() - interval '2 minutes')
$$;
revoke all on function public.alert_recent(uuid, uuid) from public, anon, authenticated;

/* ---------- added as a watcher ---------- */
create or replace function public.alert_task_person() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); t record; who uuid;
begin
  if coalesce(j->>'kind', 'employee') <> 'employee' or (j->>'employee_id') is null or coalesce(j->>'item_type', 'task') <> 'task' then return new; end if;
  who := (j->>'employee_id')::uuid;
  select id, title, to_jsonb(tt)->>'tenant_id' as tenant, assignee_id into t from public.tracking_tasks tt where id = (j->>'item_id')::uuid;
  if not found or t.assignee_id is not distinct from who or public.alert_recent(who, t.id) then return new; end if;
  perform public.alert_push(who, t.tenant::uuid, 'task_added', coalesce(t.title, 'A task'), 'you were added as a watcher', 'task', t.id, null);
  return new;
end $$;

/* ---------- description mentions and steps given to someone ---------- */
create or replace function public.alert_task_content() returns trigger language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  title text := coalesce(j->>'title', 'A task');
  tenant uuid := (j->>'tenant_id')::uuid;
  who uuid; st jsonb; ost jsonb;
begin
  -- people newly @mentioned in the description
  if coalesce(j->>'description', '') is distinct from coalesce(o->>'description', '') then
    for who in select public.alert_mentions(j->>'description') except select public.alert_mentions(o->>'description') loop
      perform public.alert_push(who, tenant, 'mention', title, 'mentioned you in the description', 'task', new.id, null);
    end loop;
  end if;
  -- steps now given to someone (a new step, or one passed to someone else)
  if jsonb_typeof(j->'checklist') = 'array' and (j->'checklist') is distinct from (o->'checklist') then
    for st in select x from jsonb_array_elements(j->'checklist') as x loop
      if coalesce(st->>'who', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then continue; end if;
      if coalesce(st->>'done', 'false') = 'true' then continue; end if;
      ost := null;
      if jsonb_typeof(o->'checklist') = 'array' then
        select x into ost from jsonb_array_elements(o->'checklist') as x where x->>'id' = st->>'id' limit 1;
      end if;
      if ost is not null and ost->>'who' is not distinct from st->>'who' then continue; end if;
      perform public.alert_push((st->>'who')::uuid, tenant, 'task_step', title, public.alert_plain(st->>'text', 200), 'task', new.id, null);
    end loop;
  end if;
  return new;
end $$;

/* ---------- comments / notes: mentioned people get a mention, the rest of the task a message ---------- */
create or replace function public.alert_task_message() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); t jsonb; who uuid; preview text; ment uuid[]; author uuid := (j->>'author_id')::uuid;
begin
  select to_jsonb(tt) into t from public.tracking_tasks tt where id = (j->>'task_id')::uuid;
  if t is null then return new; end if;
  preview := public.alert_plain(j->>'body');
  ment := array(select public.alert_mentions(j->>'body'));
  foreach who in array ment loop
    if who is distinct from author then
      perform public.alert_push(who, (t->>'tenant_id')::uuid, 'mention', coalesce(t->>'title', 'A task'), preview, 'task', (t->>'id')::uuid, null);
    end if;
  end loop;
  for who in
    select distinct u from (
      select (t->>'assignee_id')::uuid as u
      union select (t->>'created_by')::uuid
      union select (to_jsonb(a)->>'employee_id')::uuid from public.tracking_assignees a
        where to_jsonb(a)->>'item_id' = t->>'id' and coalesce(to_jsonb(a)->>'item_type', 'task') = 'task'
    ) s where u is not null and u is distinct from author and not (u = any(ment))
  loop
    perform public.alert_push(who, (t->>'tenant_id')::uuid, 'message', coalesce(t->>'title', 'A task'), preview, 'task', (t->>'id')::uuid, null);
  end loop;
  return new;
end $$;

do $$ begin
  if to_regclass('public.tracking_assignees') is not null then
    drop trigger if exists trg_alert_task_person on public.tracking_assignees;
    create trigger trg_alert_task_person after insert on public.tracking_assignees for each row execute function public.alert_task_person();
  end if;
  if to_regclass('public.tracking_task_updates') is not null then
    drop trigger if exists trg_alert_task_message on public.tracking_task_updates;
    create trigger trg_alert_task_message after insert on public.tracking_task_updates for each row execute function public.alert_task_message();
  end if;
  if to_regclass('public.tracking_tasks') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tracking_tasks' and column_name = 'description')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tracking_tasks' and column_name = 'checklist') then
    drop trigger if exists trg_alert_task_content on public.tracking_tasks;
    create trigger trg_alert_task_content after insert or update of description, checklist on public.tracking_tasks for each row execute function public.alert_task_content();
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

select tgname from pg_trigger where tgname in ('trg_alert_task_person', 'trg_alert_task_message', 'trg_alert_task_content') order by 1;
