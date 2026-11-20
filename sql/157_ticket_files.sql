-- 157 · Files and pictures on tickets and tasks (Enterprise)
-- Dropped on a ticket / task, they go with a comment (update_id) and also show in the ticket's Files folder.
-- Stored in the private bucket "ticket-files" under <tenant>/<task>/<uuid>_<name>, like tracking-files.

create table if not exists public.ticket_files (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant(),
  task_id      uuid not null references public.tracking_tasks(id) on delete cascade,
  update_id    uuid references public.tracking_task_updates(id) on delete set null,
  storage_path text not null,
  name         text not null,
  mime         text,
  size_bytes   bigint,
  uploaded_by  uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists ticket_files_task_idx on public.ticket_files (task_id, created_at);
create index if not exists ticket_files_update_idx on public.ticket_files (update_id);

alter table public.ticket_files enable row level security;

drop policy if exists ticket_files_select on public.ticket_files;
create policy ticket_files_select on public.ticket_files for select
  using (tenant_id = (select current_tenant()) and exists (select 1 from public.tracking_tasks t where t.id = ticket_files.task_id));
drop policy if exists ticket_files_insert on public.ticket_files;
create policy ticket_files_insert on public.ticket_files for insert
  with check (tenant_id = (select current_tenant()) and uploaded_by = (select auth.uid())
              and exists (select 1 from public.tracking_tasks t where t.id = ticket_files.task_id));
drop policy if exists ticket_files_update on public.ticket_files;
create policy ticket_files_update on public.ticket_files for update
  using (tenant_id = (select current_tenant()) and uploaded_by = (select auth.uid()))
  with check (tenant_id = (select current_tenant()) and uploaded_by = (select auth.uid()));
drop policy if exists ticket_files_delete on public.ticket_files;
create policy ticket_files_delete on public.ticket_files for delete
  using (tenant_id = (select current_tenant()) and uploaded_by = (select auth.uid()));

-- the bucket: private, 50 MB a file, read / write / delete inside your own company's folder
insert into storage.buckets (id, name, public, file_size_limit)
values ('ticket-files', 'ticket-files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists ticket_files_obj_read on storage.objects;
create policy ticket_files_obj_read on storage.objects for select
  using (bucket_id = 'ticket-files' and (split_part(name, '/', 1))::uuid = current_tenant());
drop policy if exists ticket_files_obj_write on storage.objects;
create policy ticket_files_obj_write on storage.objects for insert
  with check (bucket_id = 'ticket-files' and (split_part(name, '/', 1))::uuid = current_tenant());
drop policy if exists ticket_files_obj_delete on storage.objects;
create policy ticket_files_obj_delete on storage.objects for delete
  using (bucket_id = 'ticket-files' and (split_part(name, '/', 1))::uuid = current_tenant());
