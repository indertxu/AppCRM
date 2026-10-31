-- =====================================================================
-- 85_series_invites.sql — a repeating booking is answered once
-- =====================================================================
-- Inviting someone to a repeating booking sent one invitation per date, and
-- each had to be accepted on its own. Now:
--   · they get ONE notification for the whole series (saying it repeats),
--   · answering it answers every date (the app does that),
--   · dates the series adds later (it keeps filling ahead) follow the answer
--     they already gave: accepted → straight onto their calendar, with the
--     work type they chose; declined → declined. Nobody is asked again.
--   · the organiser gets one "accepted / declined" notice per series, not
--     one per date.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;

create or replace function public.alert_invite()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  j jsonb; e jsonb; sid uuid;
  prev_status text; prev_wt uuid;
begin
  if tg_op = 'DELETE' then j := to_jsonb(old); else j := to_jsonb(new); end if;
  select to_jsonb(ce) into e from public.calendar_entries ce where id = (j->>'entry_id')::uuid;
  sid := nullif(e->>'series_id', '')::uuid;

  if tg_op = 'INSERT' then
    if e is null then return new; end if;
    if sid is not null then
      -- the answer this person already gave on this series decides the new date
      select i.status, mine.work_type_id into prev_status, prev_wt
        from public.entry_invites i
        join public.calendar_entries oe on oe.id = i.entry_id
        left join public.calendar_entries mine on mine.invite_id = i.id
       where oe.series_id = sid and i.invitee_id = new.invitee_id and i.id <> new.id
         and i.status in ('accepted', 'declined')
       order by i.responded_at desc nulls last
       limit 1;
      if prev_status = 'accepted' then
        insert into public.calendar_entries (
          user_id, tenant_id, kind, title, date_key, entry_date, start_min, end_min, work_type_id,
          project_id, client_id, company_id, tracking_id, meeting_kind, billable, billing_line, role_id,
          status, notes, invite_id)
        values (
          new.invitee_id, coalesce(new.tenant_id, (e->>'tenant_id')::uuid), coalesce(e->>'kind', 'work'), e->>'title',
          e->>'date_key', (e->>'entry_date')::date, (e->>'start_min')::int, (e->>'end_min')::int,
          coalesce(prev_wt, (e->>'work_type_id')::uuid),
          (e->>'project_id')::uuid, (e->>'client_id')::uuid, (e->>'company_id')::uuid, (e->>'tracking_id')::uuid,
          e->>'meeting_kind', coalesce(new.billable, 0), new.billing_line, coalesce(new.role_id, (e->>'role_id')::uuid),
          case when (e->>'entry_date')::date <= current_date then 'confirmed' else 'planned' end, e->>'notes', new.id);
        perform set_config('app.series_auto', '1', true);
        update public.entry_invites set status = 'accepted', responded_at = now(), seen_by_organiser = true where id = new.id;
        perform set_config('app.series_auto', '', true);
        return new;
      elsif prev_status = 'declined' then
        perform set_config('app.series_auto', '1', true);
        update public.entry_invites set status = 'declined', responded_at = now(), seen_by_organiser = true where id = new.id;
        perform set_config('app.series_auto', '', true);
        return new;
      end if;
      -- still unanswered: the first date already told them, one notification is enough
      if exists (
        select 1 from public.entry_invites i join public.calendar_entries oe on oe.id = i.entry_id
         where oe.series_id = sid and i.invitee_id = new.invitee_id and i.id <> new.id and i.status = 'pending'
      ) then return new; end if;
    end if;
    perform public.alert_push((j->>'invitee_id')::uuid, (coalesce(j->>'tenant_id', e->>'tenant_id'))::uuid, 'invite',
      coalesce(e->>'title', 'A meeting'),
      case when sid is not null then coalesce(nullif(j->>'message', '') || ' · ', '') || 'Repeats — one answer covers every date' else j->>'message' end,
      'invite', (j->>'id')::uuid, public.alert_entry_at(e));
    return new;

  elsif tg_op = 'UPDATE' then
    if (old.status is distinct from new.status) and new.status in ('accepted', 'declined') then
      if coalesce(current_setting('app.series_auto', true), '') = '1' then return new; end if;
      -- one answer on a series: the organiser hears it once, not once per date
      if sid is not null and exists (
        select 1 from public.user_alerts ua join public.calendar_entries oe on oe.id = ua.ref_id
         where ua.user_id = (j->>'organiser_id')::uuid and ua.kind = 'invite_' || new.status
           and ua.actor_id is not distinct from auth.uid() and oe.series_id = sid
           and ua.created_at > now() - interval '10 minutes'
      ) then return new; end if;
      perform public.alert_push((j->>'organiser_id')::uuid, (coalesce(j->>'tenant_id', e->>'tenant_id'))::uuid, 'invite_' || new.status, coalesce(e->>'title', 'Your meeting'), null, 'entry', (j->>'entry_id')::uuid, public.alert_entry_at(e));
    end if;
    return new;

  else
    -- the entry itself being deleted is announced by alert_entry_gone (with its title)
    if e is null or coalesce(j->>'status', '') = 'declined' then return old; end if;
    perform public.alert_push((j->>'invitee_id')::uuid, (coalesce(j->>'tenant_id', e->>'tenant_id'))::uuid, 'invite_removed', coalesce(e->>'title', 'A meeting'), null, 'entry', (j->>'entry_id')::uuid, public.alert_entry_at(e));
    return old;
  end if;
end $function$;

commit;

select 'repeating invitations: answered once' as status;
