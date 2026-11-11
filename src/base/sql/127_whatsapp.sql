-- =====================================================================
-- 127_whatsapp.sql — Base · Settings › Integrations: WhatsApp Business
-- =====================================================================
-- WhatsApp Cloud API through the same Meta app ("Next"):
--   connected_assets.kind may be 'whatsapp_number' — a phone number of a
--     WhatsApp Business account the Meta login shares (external_id = the
--     phone_number_id; extra: waba_id, display_phone_number, verified_name,
--     quality_rating, status).
--   whatsapp_messages — messages in / out of those numbers. Written only by
--     the edge functions (whatsapp-webhook for incoming + status updates,
--     connected-accounts for sending); the number's owner reads them (RLS).
-- Additive (a check widened, one new table).
-- =====================================================================
alter table public.connected_assets drop constraint if exists connected_assets_kind_check;
alter table public.connected_assets add constraint connected_assets_kind_check
  check (kind in ('facebook_page', 'instagram', 'ad_account', 'linkedin_org', 'mailrelay_group', 'whatsapp_number'));

create table if not exists public.whatsapp_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  user_id         uuid not null,                         -- owner of the connected number
  asset_id        uuid references public.connected_assets(id) on delete set null,
  phone_number_id text not null,                         -- our number (Cloud API id)
  wa_message_id   text unique,                           -- wamid.…
  direction       text not null check (direction in ('in', 'out')),
  contact_phone   text not null,                         -- the other side, digits only (e.g. 34600111222)
  contact_name    text,
  type            text not null default 'text',          -- text, image, template, …
  body            text,
  status          text,                                  -- out: sent / delivered / read / failed; in: received
  error           text,
  payload         jsonb not null default '{}',
  sent_by         uuid,                                  -- out: who sent it from the app
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists whatsapp_messages_contact on public.whatsapp_messages (tenant_id, contact_phone, created_at desc);
create index if not exists whatsapp_messages_number on public.whatsapp_messages (phone_number_id, created_at desc);
alter table public.whatsapp_messages enable row level security;
drop policy if exists whatsapp_messages_own_select on public.whatsapp_messages;
create policy whatsapp_messages_own_select on public.whatsapp_messages
  for select using (user_id = auth.uid() and tenant_id = current_tenant());
grant select on public.whatsapp_messages to authenticated;

notify pgrst, 'reload schema';
