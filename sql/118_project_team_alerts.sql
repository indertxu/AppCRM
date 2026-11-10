-- 118_project_team_alerts.sql  ·  Everyone put on a project's team gets a notification.
--
-- When a project is created (Incoming › Build project) every person on its team gets
-- "<who> put you on a new project · <client>" in their notifications (Home bell), with the service and kick-off date.
-- Someone added to the team of an existing project later gets "added you to a project".
-- The person who does it isn't notified about themselves (alert_push skips the actor).
-- Additive: a function and a trigger.

create or replace function public.alert_project_team() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client  text;
  v_service text;
  v_body    text;
  v_kind    text := case when tg_op = 'INSERT' then 'project_new' else 'project_added' end;
  v_user    uuid;
begin
  if jsonb_typeof(new.team) is distinct from 'array' then return new; end if;
  select coalesce(nullif(c.name, ''), c.legal_name) into v_client from clients c where c.id = new.client_id;
  select s.name into v_service from services s where s.id = coalesce(new.service_id, new.project_type_id);
  v_body := concat_ws(' · ', v_service,
              case when new.kickoff_date is not null then 'Kick-off ' || to_char(new.kickoff_date, 'FMDD Mon YYYY') end);

  for v_user in
    select distinct (m->>'userId')::uuid
      from jsonb_array_elements(new.team) m
     where coalesce(m->>'userId', '') ~ '^[0-9a-f-]{36}$'
       and (tg_op = 'INSERT' or jsonb_typeof(old.team) is distinct from 'array'
            or not exists (select 1 from jsonb_array_elements(old.team) o where o->>'userId' = m->>'userId'))
  loop
    perform public.alert_push(v_user, new.tenant_id, v_kind, coalesce(v_client, 'A new project'), nullif(v_body, ''), 'project', new.id, null);
  end loop;
  return new;
end $$;

create or replace trigger trg118_project_team_alerts
  after insert or update of team on public.projects
  for each row execute function public.alert_project_team();
