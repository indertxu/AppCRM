-- =====================================================================
-- 89_contact_direction.sql — Contacts read from Outlook, incoming and outgoing
--
--   · client_contacts_log.direction  'in' (they reached us) / 'out' (we reached them)
--   · client_contacts_log.source     'manual' (logged by hand), 'email' (read from
--                                    Outlook), 'auto' (an automatic follow-up e-mail)
--   · client_contacts_log.external_id the e-mail's Internet message id: each e-mail is
--                                    logged once per client, however often it is read
--   · client_contacts_log.contact_email who wrote / was written to
--   · cs_mail_sync                   how far each person's mailbox has been read
-- Safe to run more than once.
-- =====================================================================
begin;

alter table public.client_contacts_log add column if not exists direction text;
alter table public.client_contacts_log add column if not exists source text not null default 'manual';
alter table public.client_contacts_log add column if not exists external_id text;
alter table public.client_contacts_log add column if not exists contact_email text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_contacts_log_direction_chk') then
    alter table public.client_contacts_log add constraint client_contacts_log_direction_chk check (direction is null or direction in ('in', 'out'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_contacts_log_source_chk') then
    alter table public.client_contacts_log add constraint client_contacts_log_source_chk check (source in ('manual', 'email', 'auto'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_contacts_log_ext_uq') then
    alter table public.client_contacts_log add constraint client_contacts_log_ext_uq unique (client_id, external_id);
  end if;
end $$;
create index if not exists client_contacts_log_client_at on public.client_contacts_log (client_id, contacted_at desc);

-- the automatic follow-up e-mails already logged went out from us
update public.client_contacts_log set direction = 'out', source = 'auto'
 where direction is null and reason like 'Automatic e-mail%';

-- how far each mailbox has been read (the newest e-mail seen) and what it found
create table if not exists public.cs_mail_sync (
  user_id uuid primary key,
  tenant_id uuid,
  read_after timestamptz,
  scanned integer not null default 0,
  logged integer not null default 0,
  done_backfill boolean not null default false,
  last_run_at timestamptz,
  last_error text
);
alter table public.cs_mail_sync enable row level security;
drop policy if exists tenant_read on public.cs_mail_sync;
create policy tenant_read on public.cs_mail_sync for select to authenticated using (tenant_id = public.current_tenant());
grant select on public.cs_mail_sync to authenticated;

notify pgrst, 'reload schema';
commit;
