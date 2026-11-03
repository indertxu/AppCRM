-- =====================================================================
-- 91_cs_quiet_rule.sql — Follow-up sequences that start when a client goes quiet
--
--   · cs_sequences.audience.quiet_days  (jsonb, no column) a client only starts the
--                                       sequence once its last contact is that many days old
--   · cs_sequence_runs.started_at       when the client's current round began (a contact
--                                       after it can stop the round: audience.quiet_stop)
--   · cs_last_contacts(tenant)          each client's last contact, and its last one that
--                                       wasn't an automatic e-mail
-- Safe to run more than once.
-- =====================================================================
begin;

alter table public.cs_sequence_runs add column if not exists started_at timestamptz;
update public.cs_sequence_runs set started_at = created_at where started_at is null;
alter table public.cs_sequence_runs alter column started_at set default now();

create or replace function public.cs_last_contacts(p_tenant uuid)
returns table (client_id uuid, last_at timestamptz, last_human_at timestamptz)
language sql stable
set search_path = public
as $$
  select l.client_id,
         max(l.contacted_at) as last_at,
         max(l.contacted_at) filter (where coalesce(l.source, 'manual') <> 'auto') as last_human_at
    from public.client_contacts_log l
   where l.tenant_id = p_tenant
   group by l.client_id
$$;
revoke all on function public.cs_last_contacts(uuid) from public, anon, authenticated;
grant execute on function public.cs_last_contacts(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
