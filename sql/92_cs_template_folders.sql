-- =====================================================================
-- 92_cs_template_folders.sql — Folders for the e-mail blueprints
--
--   · cs_email_folders            a company's folders (name, colour, order)
--   · cs_email_templates.folder_id the folder a blueprint is in (none: not filed);
--                                 deleting a folder leaves its blueprints unfiled
-- Safe to run more than once.
-- =====================================================================
begin;

create table if not exists public.cs_email_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null default 'New folder',
  color text,
  sort integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists cs_email_folders_tenant on public.cs_email_folders (tenant_id, sort);

alter table public.cs_email_templates add column if not exists folder_id uuid references public.cs_email_folders(id) on delete set null;
create index if not exists cs_email_templates_folder on public.cs_email_templates (folder_id);

do $$ begin
  if to_regprocedure('public.set_tenant_id()') is not null then
    drop trigger if exists trg_set_tenant on public.cs_email_folders;
    create trigger trg_set_tenant before insert on public.cs_email_folders for each row execute function set_tenant_id();
  end if;
end $$;
alter table public.cs_email_folders enable row level security;
drop policy if exists tenant_all on public.cs_email_folders;
create policy tenant_all on public.cs_email_folders for all to authenticated
  using (tenant_id = public.current_tenant()) with check (tenant_id is null or tenant_id = public.current_tenant());
grant select, insert, update, delete on public.cs_email_folders to authenticated;

notify pgrst, 'reload schema';
commit;
