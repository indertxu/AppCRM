-- =====================================================================
-- 59_tickets_vs_tasks.sql — tickets and tasks, kept apart
-- =====================================================================
-- Tickets are conversations: e-mails received, messages, calls — with clients
-- or inside the team. Tasks are the work: things someone has to get done.
-- They share one table (tracking_tasks); this adds which one each row is:
--   * category: 'ticket' or 'task'
--   * a new channel for tickets: 'message' (a message from a client or a colleague)
-- Existing rows are sorted once: e-mail / phone / portal, or a requester filled
-- in → ticket; everything else (deal tasks, to-dos) → task. New rows without a
-- category (e.g. e-mail read by the mail sync) are sorted the same way.
-- You can turn one into the other from its ⋯ menu. Nothing is deleted.
-- Run 14_tickets.sql first. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

alter table public.tracking_tasks add column if not exists category text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tracking_tasks_category_check') then
    alter table public.tracking_tasks add constraint tracking_tasks_category_check
      check (category is null or category in ('ticket', 'task'));
  end if;
  -- the channels a ticket can come in by: + 'message'
  if exists (select 1 from pg_constraint where conname = 'tracking_tasks_source_check')
     and not exists (select 1 from pg_constraint where conname = 'tracking_tasks_source_check'
                     and pg_get_constraintdef(oid) ilike '%message%') then
    alter table public.tracking_tasks drop constraint tracking_tasks_source_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tracking_tasks_source_check') then
    alter table public.tracking_tasks add constraint tracking_tasks_source_check
      check (source in ('manual', 'email', 'sales', 'phone', 'portal', 'message'));
  end if;
end $$;

-- sort what's there
update public.tracking_tasks
   set category = case
     when source in ('email', 'phone', 'portal', 'message')
       or coalesce(requester_email, '') <> '' or coalesce(requester_name, '') <> '' or requester_contact_id is not null
     then 'ticket' else 'task' end
 where category is null;

-- new rows without a category get one the same way
create or replace function public.tracking_tasks_category() returns trigger
language plpgsql as $$
begin
  if new.category is null then
    new.category := case
      when new.source in ('email', 'phone', 'portal', 'message')
        or coalesce(new.requester_email, '') <> '' or coalesce(new.requester_name, '') <> '' or new.requester_contact_id is not null
      then 'ticket' else 'task' end;
  end if;
  return new;
end $$;
drop trigger if exists trg_tracking_tasks_category on public.tracking_tasks;
create trigger trg_tracking_tasks_category before insert on public.tracking_tasks
  for each row execute function public.tracking_tasks_category();

create index if not exists tracking_tasks_category on public.tracking_tasks (category);

notify pgrst, 'reload schema';
commit;

select category, count(*) from public.tracking_tasks group by 1 order by 1;
