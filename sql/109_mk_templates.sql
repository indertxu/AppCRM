-- 109: Marketing › e-mail templates: an e-mail written for a campaign, saved to start the next ones from.
create table if not exists public.mk_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  name text not null default 'Untitled template',
  subject text not null default '',
  preheader text,
  body_html text not null default '',
  used_count integer not null default 0,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mk_templates_tenant on public.mk_templates (tenant_id, updated_at desc);
alter table public.mk_templates enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'mk_templates' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on public.mk_templates for all
      using (tenant_id = (select public.current_tenant())) with check (tenant_id = (select public.current_tenant()));
  end if;
end $$;
drop trigger if exists trg_set_tenant on public.mk_templates;
create trigger trg_set_tenant before insert on public.mk_templates for each row execute function public.set_tenant_id();
grant select, insert, update, delete on public.mk_templates to authenticated;
