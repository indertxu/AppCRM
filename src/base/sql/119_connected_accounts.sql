-- =====================================================================
-- 119_connected_accounts.sql — Base · Settings › Integrations
-- =====================================================================
-- Several mail / calendar accounts per person (two Gmails, two Outlooks…).
--   connected_accounts        one row per account: provider, address, what it
--                             is used for (mail / calendar). The person sees
--                             and removes their own rows (RLS).
--   connected_account_tokens  the OAuth tokens. RLS on and NO policies: only
--                             the service role (edge function
--                             "connected-accounts") reads or writes them.
-- The existing single Outlook connection (outlook_tokens) is untouched and
-- keeps working; this table holds the accounts added on top of it.
-- Additive only. Safe to run more than once.
-- =====================================================================
begin;

create table if not exists public.connected_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider      text not null check (provider in ('google', 'microsoft')),
  email         text not null,
  display_name  text,
  services      text[] not null default '{}',          -- 'mail', 'calendar'
  scopes        text,
  status        text not null default 'active' check (status in ('active', 'error')),
  last_error    text,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, provider, email)
);
create index if not exists connected_accounts_user on public.connected_accounts (user_id);
create index if not exists connected_accounts_tenant on public.connected_accounts (tenant_id);

alter table public.connected_accounts enable row level security;
drop policy if exists connected_accounts_own_select on public.connected_accounts;
create policy connected_accounts_own_select on public.connected_accounts
  for select using (user_id = auth.uid() and tenant_id = current_tenant());
drop policy if exists connected_accounts_own_delete on public.connected_accounts;
create policy connected_accounts_own_delete on public.connected_accounts
  for delete using (user_id = auth.uid() and tenant_id = current_tenant());
-- inserts / updates only through the edge function (service role)

create table if not exists public.connected_account_tokens (
  account_id    uuid primary key references public.connected_accounts(id) on delete cascade,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.connected_account_tokens enable row level security;
revoke all on public.connected_account_tokens from anon, authenticated;

grant select, delete on public.connected_accounts to authenticated;

notify pgrst, 'reload schema';
commit;
