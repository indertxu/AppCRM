-- 156 · E-mail signatures: each person keeps their own (pasted, or brought over from their Outlook),
-- one of them the default; the Tickets page adds it at the end of a reply sent by e-mail.
-- Images are kept inside the HTML (data: URIs); outlook-sync sends them as inline attachments.
create table if not exists public.mail_signatures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'Signature',
  html text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mail_signatures_user on public.mail_signatures (user_id);
-- one default per person
create unique index if not exists mail_signatures_one_default on public.mail_signatures (user_id) where is_default;

alter table public.mail_signatures enable row level security;
drop policy if exists mail_signatures_own on public.mail_signatures;
create policy mail_signatures_own on public.mail_signatures for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.mail_signatures to authenticated;
