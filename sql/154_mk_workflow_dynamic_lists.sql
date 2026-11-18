-- =====================================================================
-- 154 · Marketing › Workflows: "Joins a list" with DYNAMIC lists too
--
-- A dynamic list is a set of rules (its members are worked out in the app, MkEngine in
-- ContactExport.tsx). To start a workflow when someone comes into one, the app now reads
-- the dynamic lists that start an active workflow every 15 minutes (one browser of the
-- company at a time: mk_dyn_lease) and hands the people in each one to
-- mk_sync_dynamic_list(list, contacts[]). The database keeps who's in each one
-- (mk_dynamic_members) and, for everyone who has just come in:
--   · starts every active "list" workflow of that list (mk_workflow_runs, as 153);
--   · someone who left and comes back starts again (source 'list:<list>:<contact>:<n>').
-- The first time a list is read nobody "comes in": the people already in it only start
-- the workflows switched on with "Also the people already in it" (backfill).
-- mk_wf_list_backfill (153) also takes the people already in a dynamic list.
-- Nothing is dropped or renamed. Safe to run twice.
-- =====================================================================

create table if not exists public.mk_dynamic_members (
  list_id    uuid not null references public.marketing_lists(id) on delete cascade,
  contact_id uuid not null,
  tenant_id  uuid,
  entries    integer not null default 1,
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (list_id, contact_id)
);
create index if not exists mk_dynamic_members_tenant on public.mk_dynamic_members (tenant_id);

create table if not exists public.mk_dynamic_sync (
  tenant_id uuid primary key,
  at        timestamptz not null default now(),
  by        uuid
);

do $$
declare t text;
begin
  foreach t in array array['mk_dynamic_members', 'mk_dynamic_sync'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I for all to authenticated using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()))', t);
  end loop;
end $$;

-- may this browser read the dynamic lists now? (once every p_minutes per company)
create or replace function public.mk_dyn_lease(p_minutes integer default 15)
returns boolean language plpgsql security definer set search_path = public as $$
declare t uuid := public.current_tenant(); ok boolean;
begin
  if t is null then return false; end if;
  insert into public.mk_dynamic_sync (tenant_id, at, by) values (t, now(), auth.uid())
  on conflict (tenant_id) do update set at = now(), by = auth.uid()
    where public.mk_dynamic_sync.at < now() - make_interval(mins => greatest(1, coalesce(p_minutes, 15)))
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- one person coming into a dynamic list: the active "list" workflows of that list
create or replace function public.mk_wf_dyn_runs(p_list uuid, p_contact uuid, p_entry integer, p_all boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  insert into public.mk_workflow_runs (tenant_id, workflow_id, source, contact_id, email, name, merge, node, status, next_at)
  select w.tenant_id, w.id,
         'list:' || p_list::text || ':' || ct.id::text || case when coalesce(p_entry, 1) > 1 then ':' || p_entry::text else '' end,
         ct.id, ct.email, nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''),
         jsonb_build_object('list_name', coalesce(l.name, '')), '0', 'active', now()
    from public.mk_workflows w
    join public.marketing_lists l on l.id = p_list and l.tenant_id is not distinct from w.tenant_id
    join public.contacts ct on ct.id = p_contact and ct.tenant_id is not distinct from w.tenant_id
   where w.status = 'active'
     and w.trigger->>'kind' = 'list'
     and w.trigger->>'list_id' = p_list::text
     and (p_all or coalesce((w.trigger->>'backfill')::boolean, false))
  on conflict (workflow_id, source) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- the people in a dynamic list right now (worked out in the app): who came in, who left
create or replace function public.mk_sync_dynamic_list(p_list uuid, p_contacts uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant();
  l record; seeded boolean; c record;
  n_left integer := 0; n_in integer := 0; made integer := 0;
begin
  select id, kind, tenant_id into l from public.marketing_lists where id = p_list;
  if not found or t is null or l.tenant_id is distinct from t then return jsonb_build_object('error', 'not your list'); end if;
  if l.kind <> 'dynamic' then return jsonb_build_object('error', 'not a dynamic list'); end if;
  seeded := exists (select 1 from public.mk_dynamic_members where list_id = p_list);

  -- who left
  update public.mk_dynamic_members m set left_at = now()
   where m.list_id = p_list and m.left_at is null
     and not (m.contact_id = any (coalesce(p_contacts, '{}'::uuid[])));
  get diagnostics n_left = row_count;

  -- who came in (or came back)
  for c in
    with x as (
      select distinct ct.id from unnest(coalesce(p_contacts, '{}'::uuid[])) u(id)
        join public.contacts ct on ct.id = u.id and ct.tenant_id is not distinct from t
    ), ins as (
      insert into public.mk_dynamic_members (list_id, contact_id, tenant_id)
      select p_list, x.id, t from x
      on conflict (list_id, contact_id) do update
        set entries = public.mk_dynamic_members.entries + 1, joined_at = now(), left_at = null
        where public.mk_dynamic_members.left_at is not null
      returning contact_id, entries
    )
    select * from ins
  loop
    n_in := n_in + 1;
    begin
      made := made + public.mk_wf_dyn_runs(p_list, c.contact_id, c.entries, seeded);
    exception when others then null;
    end;
  end loop;

  if made > 0 then
    insert into public.mk_workflow_events (tenant_id, workflow_id, kind, detail)
    select w.tenant_id, w.id, 'enrol', jsonb_build_object('list', p_list, 'came_in', n_in, 'dynamic', true)
      from public.mk_workflows w
     where w.status = 'active' and w.trigger->>'kind' = 'list' and w.trigger->>'list_id' = p_list::text and w.tenant_id is not distinct from t;
  end if;
  return jsonb_build_object('came_in', n_in, 'left', n_left, 'started', made, 'first', not seeded);
end $$;

grant execute on function public.mk_dyn_lease(integer) to authenticated;
grant execute on function public.mk_sync_dynamic_list(uuid, uuid[]) to authenticated;
revoke execute on function public.mk_wf_dyn_runs(uuid, uuid, integer, boolean) from public, anon, authenticated;

-- "Also the people already in it" now also takes the people in a dynamic list (as last read)
create or replace function public.mk_wf_list_backfill() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record; made integer := 0; lid uuid;
begin
  if new.status <> 'active' or new.trigger->>'kind' <> 'list' or coalesce(new.trigger->>'list_id', '') = ''
     or coalesce((new.trigger->>'backfill')::boolean, false) = false then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'active' and old.trigger = new.trigger then return new; end if;
  begin
    lid := (new.trigger->>'list_id')::uuid;
    for m in select contact_id, company_id from public.marketing_list_members where list_id = lid loop
      made := made + public.mk_wf_list_runs(lid, m.contact_id, m.company_id, new.id);
    end loop;
    for m in select contact_id from public.mk_dynamic_members where list_id = lid and left_at is null loop
      made := made + public.mk_wf_list_runs(lid, m.contact_id, null, new.id);
    end loop;
    if made > 0 then
      insert into public.mk_workflow_events (tenant_id, workflow_id, kind, detail) values (new.tenant_id, new.id, 'enrol', jsonb_build_object('made', made));
    end if;
  exception when others then null;
  end;
  return new;
end $$;
