-- =====================================================================
-- 160 · BASE · Growth › Website — the AI website builder
-- (src/base/pages/growth/website, edge function "site-ai").
--
--   base_sites          one row per website: its address (slug → <slug>.<sites domain>
--                       and /w/<slug>), the draft being edited (theme, pages and their
--                       sections, as JSON), SEO, and the copy that is live (published).
--   base_site_versions  every saved step of a site (each AI change, each publish), so
--                       any of them can be brought back.
--   public_site(slug)   what a visitor's browser reads: only the published copy of a
--                       live site (anon may call it; the draft never leaves the company).
--   bucket site-assets  public pictures for the sites (<tenant>/<site>/<file>).
-- Additive only. Base only: Enterprise doesn't read these tables.
-- =====================================================================

create table if not exists public.base_sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null default 'My website',
  -- the address: lower-case letters, digits and dashes; unique across every company
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,46}[a-z0-9])?$'),
  status text not null default 'draft' check (status in ('draft', 'live', 'paused')),
  -- the draft: { theme, nav, footer, pages: [{ id, path, title, sections: [...] }] }
  draft jsonb not null default '{}'::jsonb,
  -- { title, description, keywords[], og_image, lang }
  seo jsonb not null default '{}'::jsonb,
  -- later: { custom_domain, seo_budget_month, … }
  settings jsonb not null default '{}'::jsonb,
  -- what visitors see: a copy of draft + seo taken when "Publish" is pressed
  published jsonb,
  published_at timestamptz,
  -- what the AI was told about the business (to keep later edits in tone)
  brief jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists base_sites_tenant on public.base_sites (tenant_id, created_at);

create table if not exists public.base_site_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  site_id uuid not null references public.base_sites(id) on delete cascade,
  -- ai · manual · publish · restore
  kind text not null default 'manual',
  -- the request to the AI, or what was done
  note text not null default '',
  draft jsonb not null,
  seo jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists base_site_versions_site on public.base_site_versions (site_id, created_at desc);

-- the company only sees its own rows; the tenant is filled in on insert
do $$
declare t text;
begin
  foreach t in array array['base_sites', 'base_site_versions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I for all using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()))', t);
    execute format('drop trigger if exists trg_set_tenant on public.%I', t);
    execute format('create trigger trg_set_tenant before insert on public.%I for each row execute function set_tenant_id()', t);
  end loop;
end $$;

-- is an address free? (any company's sites count; the caller's own site may keep its own)
create or replace function public.base_site_slug_free(p_slug text, p_site uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from public.base_sites s where s.slug = lower(p_slug) and (p_site is null or s.id <> p_site));
$$;
revoke all on function public.base_site_slug_free(text, uuid) from public, anon;
grant execute on function public.base_site_slug_free(text, uuid) to authenticated;

-- a visitor reads a live site: only its published copy
create or replace function public.public_site(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('name', s.name, 'slug', s.slug, 'site', s.published, 'published_at', s.published_at)
  from public.base_sites s
  where s.slug = lower(p_slug) and s.status = 'live' and s.published is not null
  limit 1;
$$;
revoke all on function public.public_site(text) from public;
grant execute on function public.public_site(text) to anon, authenticated;

-- pictures: public to read (they load by their link), written only into your own company's folder
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-assets', 'site-assets', true, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'])
on conflict (id) do nothing;

drop policy if exists site_assets_write on storage.objects;
create policy site_assets_write on storage.objects for insert
  with check (bucket_id = 'site-assets' and (storage.foldername(name))[1] = (select current_tenant())::text);
drop policy if exists site_assets_update on storage.objects;
create policy site_assets_update on storage.objects for update
  using (bucket_id = 'site-assets' and (storage.foldername(name))[1] = (select current_tenant())::text);
drop policy if exists site_assets_delete on storage.objects;
create policy site_assets_delete on storage.objects for delete
  using (bucket_id = 'site-assets' and (storage.foldername(name))[1] = (select current_tenant())::text);
drop policy if exists site_assets_read on storage.objects;
create policy site_assets_read on storage.objects for select
  using (bucket_id = 'site-assets' and (storage.foldername(name))[1] = (select current_tenant())::text);
