-- Clients: active or churned (lost), set from the client list and the client pop-up.
--   status       'active' | 'churned'
--   churned_at   when we lost them
--   churn_reason why (free text)
-- Safe to run more than once.
alter table public.clients add column if not exists status text not null default 'active';
alter table public.clients add column if not exists churned_at date;
alter table public.clients add column if not exists churn_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'clients_status_check') then
    alter table public.clients add constraint clients_status_check check (status in ('active', 'churned'));
  end if;
end $$;
notify pgrst, 'reload schema';
