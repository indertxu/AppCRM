-- 111: Settings › APIs — keys for the CRM import API (companies & contacts, e.g. a website demo form),
-- next to the client documents keys. Same table, same /functions/v1/manage-users/api endpoint.
--   scope    'files' (client documents, as before) or 'crm' (companies & contacts)
--   access   read | write, and now 'form': may only add leads (POST /crm/leads) — safe to put in a website
--   settings for crm keys: { source, tags[], assign_to[], origins[] }
alter table public.client_api_keys add column if not exists scope text not null default 'files';
alter table public.client_api_keys add column if not exists settings jsonb not null default '{}'::jsonb;
alter table public.client_api_keys drop constraint if exists client_api_keys_access_check;
alter table public.client_api_keys add constraint client_api_keys_access_check check (access in ('read', 'write', 'form'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_api_keys_scope_check') then
    alter table public.client_api_keys add constraint client_api_keys_scope_check check (scope in ('files', 'crm'));
  end if;
end $$;
