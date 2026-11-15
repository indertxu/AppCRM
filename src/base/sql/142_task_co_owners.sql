-- 142 · Base · Tasks: more than one person responsible
-- assignee_id stays the main owner (what Enterprise and every list already read);
-- the other people responsible for the task go in co_assignee_ids.
-- Visibility is unchanged: on a task linked to a deal, a co-owner still needs to see that deal.
-- Additive.

alter table public.tracking_tasks add column if not exists co_assignee_ids uuid[] not null default '{}';
create index if not exists tracking_tasks_co_assignees_idx on public.tracking_tasks using gin (co_assignee_ids);
