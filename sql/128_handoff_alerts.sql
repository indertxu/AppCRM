-- 128_handoff_alerts.sql  ·  Who is told when sales hands over a won deal.
--
-- Management › Settings › Notifications picks the people: for every handoff, and/or per destination
-- (the service pipeline the handoff goes to). Kept in billing_settings.handoff_notify:
--   { "all": [user ids], "pipelines": { "<pipeline id>": [user ids] } }
-- When a handoff row is created, each of them gets a notification (Home bell) that opens Management › Incoming.
-- The person who sent it isn't told about their own handoff. Additive: one column, one trigger.

alter table public.billing_settings add column if not exists handoff_notify jsonb not null default '{}'::jsonb;

create or replace function public.alert_handoff_new() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb;
  v_user uuid;
  v_body text;
begin
  select handoff_notify into v_cfg from public.billing_settings
   where tenant_id = new.tenant_id order by (id = 'default') desc limit 1;
  if v_cfg is null then return new; end if;
  v_body := concat_ws(' · ', nullif(new.dest_pipeline_name, ''),
    case when coalesce(new.potential_value, 0) > 0 then replace(to_char(new.potential_value, 'FM999,999,999'), ',', '.') || ' €' end);
  for v_user in
    select distinct u::uuid from (
      select jsonb_array_elements_text(coalesce(v_cfg -> 'all', '[]'::jsonb)) u
      union all
      select jsonb_array_elements_text(coalesce(v_cfg -> 'pipelines' -> (new.dest_pipeline_id::text), '[]'::jsonb))
    ) x where u ~* '^[0-9a-f-]{36}$'
  loop
    perform public.alert_push(v_user, new.tenant_id, 'handoff_new', coalesce(nullif(new.company_name, ''), 'A won deal'), v_body, 'handoff', new.id, null);
  end loop;
  return new;
exception when others then
  return new;  -- a notification never stops a handoff
end $$;

drop trigger if exists trg128_handoff_alert on public.handoffs;
create trigger trg128_handoff_alert after insert on public.handoffs
  for each row execute function public.alert_handoff_new();
