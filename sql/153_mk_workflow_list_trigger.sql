-- =====================================================================
-- 153 · Marketing › Workflows: "Joins a list"
--
-- A workflow can now start when someone is added to a list (mk_workflows.trigger =
-- { kind: 'list', list_id, backfill }). Done in the database, at the moment it happens:
--   · someone added to marketing_list_members (by hand, an import, a form that adds to the list)
--     → one run per active "list" workflow of that list (a company member brings its contacts);
--   · a "list" workflow switched on with "Also the people already in it"
--     → one run for everyone already in the list.
-- The runs are the usual mk_workflow_runs (source 'list:<list>:<contact>', so nobody starts twice);
-- marketing-hub (wf_due, every 5 minutes) takes them step by step as before.
-- A failure here never stops the list insert. Nothing is dropped or renamed. Safe to run twice.
-- =====================================================================

create or replace function public.mk_wf_list_runs(p_list uuid, p_contact uuid, p_company uuid, p_workflow uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  insert into public.mk_workflow_runs (tenant_id, workflow_id, source, contact_id, email, name, merge, node, status, next_at)
  select w.tenant_id, w.id, 'list:' || p_list::text || ':' || c.id::text, c.id, c.email,
         nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
         jsonb_build_object('list_name', coalesce(l.name, '')), '0', 'active', now()
    from public.mk_workflows w
    join (
      select ct.id, ct.email, ct.first_name, ct.last_name from public.contacts ct where p_contact is not null and ct.id = p_contact
      union
      select ct.id, ct.email, ct.first_name, ct.last_name
        from public.company_contacts cc join public.contacts ct on ct.id = cc.contact_id
       where p_contact is null and p_company is not null and cc.company_id = p_company
    ) c on true
    left join public.marketing_lists l on l.id = p_list
   where w.status = 'active'
     and w.trigger->>'kind' = 'list'
     and w.trigger->>'list_id' = p_list::text
     and (p_workflow is null or w.id = p_workflow)
  on conflict (workflow_id, source) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- someone added to a list
create or replace function public.mk_wf_list_member_added() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.mk_wf_list_runs(new.list_id, new.contact_id, new.company_id);
  exception when others then null;   -- the list itself always gets its member
  end;
  return new;
end $$;
drop trigger if exists mk_wf_list_member_added on public.marketing_list_members;
create trigger mk_wf_list_member_added after insert on public.marketing_list_members
  for each row execute function public.mk_wf_list_member_added();

-- a "list" workflow switched on with "Also the people already in it"
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
    if made > 0 then
      insert into public.mk_workflow_events (tenant_id, workflow_id, kind, detail) values (new.tenant_id, new.id, 'enrol', jsonb_build_object('made', made));
    end if;
  exception when others then null;
  end;
  return new;
end $$;
drop trigger if exists mk_wf_list_backfill on public.mk_workflows;
create trigger mk_wf_list_backfill after insert or update of status, trigger on public.mk_workflows
  for each row execute function public.mk_wf_list_backfill();
