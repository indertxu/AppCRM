-- =====================================================================
-- 123_connected_meta.sql — Base · Settings › Integrations: Meta
-- =====================================================================
-- connected_accounts gets provider 'meta' (Facebook Login: Facebook pages,
-- the Instagram professional accounts linked to them, ad accounts).
-- connected_assets        what a Meta login gives access to: one row per
--                         Facebook page / Instagram account / ad account.
--                         The person sees their own (RLS).
-- connected_asset_tokens  each page's own access token (service role only).
-- Additive (the provider check is widened, nothing removed).
-- =====================================================================
alter table public.connected_accounts drop constraint if exists connected_accounts_provider_check;
alter table public.connected_accounts add constraint connected_accounts_provider_check check (provider in ('google', 'microsoft', 'meta'));

create table if not exists public.connected_assets (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.connected_accounts(id) on delete cascade,
  tenant_id    uuid not null default current_tenant(),
  user_id      uuid not null default auth.uid(),
  kind         text not null check (kind in ('facebook_page', 'instagram', 'ad_account')),
  external_id  text not null,
  name         text,
  username     text,
  picture_url  text,
  extra        jsonb not null default '{}',
  updated_at   timestamptz not null default now(),
  unique (account_id, kind, external_id)
);
create index if not exists connected_assets_user on public.connected_assets (user_id);
alter table public.connected_assets enable row level security;
drop policy if exists connected_assets_own_select on public.connected_assets;
create policy connected_assets_own_select on public.connected_assets
  for select using (user_id = auth.uid() and tenant_id = current_tenant());
grant select on public.connected_assets to authenticated;

create table if not exists public.connected_asset_tokens (
  asset_id     uuid primary key references public.connected_assets(id) on delete cascade,
  access_token text,
  updated_at   timestamptz not null default now()
);
alter table public.connected_asset_tokens enable row level security;
revoke all on public.connected_asset_tokens from anon, authenticated;

notify pgrst, 'reload schema';
