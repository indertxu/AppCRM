-- =====================================================================
-- 28_proposal_html.sql — proposals and contracts as web pages (HTML / PDF)
-- =====================================================================
-- Templates are now web documents instead of PowerPoint files. They live in
-- the same table as the decks (proposal_decks), told apart by `format`:
--   format = 'pptx'  the old PowerPoint decks (kept, shown as "Legacy")
--   format = 'html'  the new templates: kind 'proposal' or 'contract',
--                    the sectors they are for, and the document itself (doc)
-- Each deal proposal keeps its own edited copy in deal_proposals.doc.
-- Safe to run more than once. Changes nothing that already exists.
-- =====================================================================
begin;

create or replace function pg_temp.copy_policies(src text, dst text) returns int language plpgsql as $$
declare p record; n int := 0;
begin
  execute format('alter table public.%I enable row level security', dst);
  for p in select * from pg_policies where schemaname = 'public' and tablename = src loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst and policyname = p.policyname) then n := n + 1; continue; end if;
    begin
      execute format('create policy %I on public.%I as %s for %s to %s %s %s',
        p.policyname, dst, p.permissive, p.cmd, array_to_string(p.roles, ', '),
        case when p.qual is not null then 'using (' || p.qual || ')' else '' end,
        case when p.with_check is not null then 'with check (' || p.with_check || ')' else '' end);
      n := n + 1;
    exception when others then
      raise notice 'policy % not copied to %: %', p.policyname, dst, sqlerrm;
    end;
  end loop;
  if n = 0 and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst) then
    execute format('create policy tenant_all on public.%I for all to authenticated using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', dst);
  end if;
  return n;
end $$;

-- the table (only if 13_proposal_decks.sql was never run)
create table if not exists public.proposal_decks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null default 'Proposal',
  storage_path text,
  file_name text,
  size_bytes bigint,
  slides jsonb not null default '[]'::jsonb,
  is_default boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_set_tenant on public.proposal_decks;
create trigger trg_set_tenant before insert on public.proposal_decks for each row execute function set_tenant_id();
select pg_temp.copy_policies('crm_options', 'proposal_decks');
grant select, insert, update, delete on public.proposal_decks to authenticated;

-- ---------- HTML templates ----------
alter table public.proposal_decks alter column storage_path drop not null;
alter table public.proposal_decks
  add column if not exists format text not null default 'pptx',
  add column if not exists kind text not null default 'proposal',
  add column if not exists sectors text[] not null default '{}',
  -- { "theme": {...}, "blocks": [...], "terms": {...}, "lang": "es", "reference": {...} }
  add column if not exists doc jsonb not null default '{}'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'proposal_decks_format_check') then
    alter table public.proposal_decks add constraint proposal_decks_format_check check (format in ('pptx', 'html'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'proposal_decks_kind_check') then
    alter table public.proposal_decks add constraint proposal_decks_kind_check check (kind in ('proposal', 'contract'));
  end if;
end $$;
create index if not exists proposal_decks_format_kind on public.proposal_decks (format, kind);

-- ---------- each proposal's own copy ----------
do $$
begin
  if to_regclass('public.deal_proposals') is not null then
    alter table public.deal_proposals add column if not exists doc jsonb not null default '{}'::jsonb;
  end if;
end $$;

notify pgrst, 'reload schema';

select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'proposal_decks' and column_name in ('format', 'kind', 'sectors', 'doc')) as new_columns,   -- 4
  (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'proposal_decks' and column_name = 'storage_path') as storage_path_nullable,  -- YES
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'proposal_decks') as access_rules,
  (select count(*) from public.proposal_decks where format = 'pptx') as powerpoint_decks_kept;

commit;
