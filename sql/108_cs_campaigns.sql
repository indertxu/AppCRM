-- 108: Customer success › one-time e-mail campaigns, and sending from a team (shared) mailbox.
--   kind         'sequence' (recurring, as before) or 'campaign' (sent once, at the click of a button)
--   from_address a team mailbox to send from (e.g. a Microsoft 365 shared mailbox like CS Iberia):
--                sent with the sender's own Outlook connection, which needs "Send as" on that mailbox
--   launched_at / launched_by  when and by whom a campaign was sent
alter table public.cs_sequences add column if not exists kind text not null default 'sequence';
alter table public.cs_sequences add column if not exists from_address text;
alter table public.cs_sequences add column if not exists launched_at timestamptz;
alter table public.cs_sequences add column if not exists launched_by uuid references public.profiles(id) on delete set null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cs_sequences_kind_check') then
    alter table public.cs_sequences add constraint cs_sequences_kind_check check (kind in ('sequence', 'campaign'));
  end if;
end $$;
