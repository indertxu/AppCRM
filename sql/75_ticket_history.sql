-- =====================================================================
-- 75_ticket_history.sql — the History of tickets and tasks, logged again
-- =====================================================================
-- The History tab (on every ticket and task) reads ticket_events. This puts
-- the log back in working order and makes it record more:
--   status · priority · owner · due date · type · title (as before)
--   + description edited · client / company / deal / project linked or
--     unlinked · steps added, ticked, unticked, removed, given to someone
--   + watchers added / removed · turned into a ticket / a task
-- Whoever can see a ticket or task can read its history.
-- The log never stops a change from saving (if logging fails, the change
-- still goes through). Tasks with no history at all get their "created" line.
-- Needs 14_tickets.sql. Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  task_id uuid not null references public.tracking_tasks(id) on delete cascade,
  author_id uuid default auth.uid(),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ticket_events_task on public.ticket_events (task_id, created_at);
do $$ begin
  if to_regprocedure('public.set_tenant_id()') is not null then
    drop trigger if exists trg_set_tenant on public.ticket_events;
    create trigger trg_set_tenant before insert on public.ticket_events for each row execute function set_tenant_id();
  end if;
end $$;

-- reading: anyone who can see the task (its own row rules decide)
alter table public.ticket_events enable row level security;
drop policy if exists "ticket events: read with the task" on public.ticket_events;
create policy "ticket events: read with the task" on public.ticket_events for select to authenticated
  using (exists (select 1 from public.tracking_tasks t where t.id = ticket_events.task_id));
drop policy if exists "ticket events: write with the task" on public.ticket_events;
create policy "ticket events: write with the task" on public.ticket_events for insert to authenticated
  with check (exists (select 1 from public.tracking_tasks t where t.id = ticket_events.task_id));
grant select, insert on public.ticket_events to authenticated;

-- events written without a workspace take their task's
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tracking_tasks' and column_name = 'tenant_id') then
    execute 'update public.ticket_events e set tenant_id = t.tenant_id from public.tracking_tasks t where e.tenant_id is null and t.id = e.task_id and t.tenant_id is not null';
  end if;
end $$;

/* ---------- the log ---------- */
create or replace function public.ticket_log() returns trigger language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  t uuid := (j ->> 'tenant_id')::uuid;
  who uuid := coalesce(auth.uid(), (j ->> 'created_by')::uuid);
  f record; st jsonb; ost jsonb;
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.ticket_events (tenant_id, task_id, author_id, action, detail)
        values (t, new.id, who, 'created', jsonb_build_object('source', j ->> 'source', 'category', j ->> 'category'));
      return new;
    end if;

    -- plain fields: from → to
    for f in select * from (values
      ('stage', 'stage'), ('priority', 'priority'), ('assignee', 'assignee_id'), ('due', 'due_at'), ('type', 'ticket_type'),
      ('title', 'title'), ('category', 'category'),
      ('client', 'client_id'), ('company', 'company_id'), ('deal', 'tracking_id'), ('project', 'project_id')
    ) as x(action, col) loop
      if j ? f.col and (j -> f.col) is distinct from (o -> f.col) then
        insert into public.ticket_events (tenant_id, task_id, author_id, action, detail)
          values (t, new.id, who, f.action, jsonb_build_object('from', o -> f.col, 'to', j -> f.col));
      end if;
    end loop;

    -- the description: just that it changed (the text itself is on the task)
    if j ? 'description' and coalesce(j ->> 'description', '') is distinct from coalesce(o ->> 'description', '') then
      insert into public.ticket_events (tenant_id, task_id, author_id, action, detail) values (t, new.id, who, 'description', '{}'::jsonb);
    end if;

    -- steps: added, ticked / unticked, given to someone, removed
    if j ? 'checklist' and (j -> 'checklist') is distinct from (o -> 'checklist') then
      if jsonb_typeof(j -> 'checklist') = 'array' then
        for st in select x from jsonb_array_elements(j -> 'checklist') as x loop
          ost := null;
          if jsonb_typeof(o -> 'checklist') = 'array' then
            select x into ost from jsonb_array_elements(o -> 'checklist') as x where x ->> 'id' = st ->> 'id' limit 1;
          end if;
          if ost is null then
            insert into public.ticket_events (tenant_id, task_id, author_id, action, detail) values (t, new.id, who, 'step_add', jsonb_build_object('text', st ->> 'text'));
          else
            if coalesce((st ->> 'done')::boolean, false) is distinct from coalesce((ost ->> 'done')::boolean, false) then
              insert into public.ticket_events (tenant_id, task_id, author_id, action, detail)
                values (t, new.id, who, 'step_done', jsonb_build_object('text', st ->> 'text', 'done', coalesce((st ->> 'done')::boolean, false)));
            end if;
            if (st ->> 'who') is distinct from (ost ->> 'who') then
              insert into public.ticket_events (tenant_id, task_id, author_id, action, detail)
                values (t, new.id, who, 'step_who', jsonb_build_object('text', st ->> 'text', 'to', st ->> 'who'));
            end if;
          end if;
        end loop;
      end if;
      if jsonb_typeof(o -> 'checklist') = 'array' then
        for ost in select x from jsonb_array_elements(o -> 'checklist') as x loop
          if jsonb_typeof(j -> 'checklist') <> 'array' or not exists (select 1 from jsonb_array_elements(j -> 'checklist') as y where y ->> 'id' = ost ->> 'id') then
            insert into public.ticket_events (tenant_id, task_id, author_id, action, detail) values (t, new.id, who, 'step_remove', jsonb_build_object('text', ost ->> 'text'));
          end if;
        end loop;
      end if;
    end if;
  exception when others then
    raise warning 'ticket_log: %', sqlerrm;   -- the change itself always saves
  end;
  return new;
end $$;
drop trigger if exists trg_ticket_log on public.tracking_tasks;
create trigger trg_ticket_log after insert or update on public.tracking_tasks for each row execute function public.ticket_log();

/* ---------- watchers (tracking_assignees, people on a task) ---------- */
create or replace function public.ticket_log_watchers() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old)); task uuid; t uuid;
begin
  begin
    if r ->> 'item_type' is distinct from 'task' or r ->> 'kind' is distinct from 'employee' then return null; end if;
    task := (r ->> 'item_id')::uuid;
    select (to_jsonb(x) ->> 'tenant_id')::uuid into t from public.tracking_tasks x where x.id = task;
    if not found then return null; end if;
    insert into public.ticket_events (tenant_id, task_id, author_id, action, detail)
      values (t, task, auth.uid(), case when tg_op = 'INSERT' then 'watcher_add' else 'watcher_remove' end, jsonb_build_object('who', r ->> 'employee_id'));
  exception when others then
    raise warning 'ticket_log_watchers: %', sqlerrm;
  end;
  return null;
end $$;
do $$ begin
  if to_regclass('public.tracking_assignees') is not null then
    drop trigger if exists trg_ticket_log_watchers on public.tracking_assignees;
    create trigger trg_ticket_log_watchers after insert or delete on public.tracking_assignees for each row execute function public.ticket_log_watchers();
  end if;
end $$;

-- tasks with no history at all: their "created" line, at the time they were made
insert into public.ticket_events (tenant_id, task_id, author_id, action, detail, created_at)
select (to_jsonb(t) ->> 'tenant_id')::uuid, t.id, (to_jsonb(t) ->> 'created_by')::uuid, 'created',
       jsonb_build_object('source', to_jsonb(t) ->> 'source', 'category', to_jsonb(t) ->> 'category'),
       coalesce((to_jsonb(t) ->> 'created_at')::timestamptz, now())
  from public.tracking_tasks t
 where not exists (select 1 from public.ticket_events e where e.task_id = t.id);

notify pgrst, 'reload schema';
commit;

select count(*) as events, count(distinct task_id) as tasks_with_history,
       count(*) filter (where created_at > now() - interval '1 day') as last_24h
  from public.ticket_events;
