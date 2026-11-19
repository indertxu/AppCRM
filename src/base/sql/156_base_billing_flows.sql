-- =====================================================================
-- 156 · BASE · Billing › Workflows — what happens to an invoice once it exists
-- (src/base/pages/billing/flows, edge function "billing-flows").
--
--   base_billing_entities   the companies that issue invoices (legal name, tax id,
--                           address, IBAN, logo). One is the default.
--   base_billing_blueprints how an invoice looks as a PDF (layout, colour, texts,
--                           language) and the e-mail that carries it when the
--                           workflow uses no Marketing template.
--   base_billing_flows      the workflows: when (the billing day / an invoice is
--                           issued / N days before it's due / N days overdue),
--                           which clients (all, these, all but these), from which
--                           company, which mailbox, which e-mail and which PDF.
--                           Lower position = checked first; the first workflow
--                           that takes an invoice for a step sends it.
--   base_billing_flow_sends every e-mail sent (or failed) — one per invoice and
--                           step ("invoice", "before_due:3", "overdue:7"), so the
--                           same mail never goes out twice.
--   invoices.entity_id      the company that issued it (stamped when it's sent).
--   hourly (pg_cron "base-billing-flows", :17): billing-flows { action: "due" }.
-- Additive only. Base only: Enterprise doesn't read these tables.
-- =====================================================================

create table if not exists public.base_billing_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null default '',
  legal_name text not null default '',
  tax_id text not null default '',
  street text not null default '',
  postal_code text not null default '',
  city text not null default '',
  province text not null default '',
  country text not null default 'ES',
  email text not null default '',
  phone text not null default '',
  website text not null default '',
  iban text not null default '',
  logo_url text not null default '',
  color text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.base_billing_blueprints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null default 'Untitled blueprint',
  design jsonb not null default '{}'::jsonb,
  email_subject text not null default '',
  email_body text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.base_billing_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null default 'Untitled workflow',
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  position integer not null default 0,
  -- billing_day · issued · before_due · overdue
  trigger text not null default 'billing_day',
  trigger_days integer not null default 0,
  -- { mode: all | only | except, client_ids: [] }
  audience jsonb not null default '{"mode":"all","client_ids":[]}'::jsonb,
  entity_id uuid references public.base_billing_entities(id) on delete set null,
  blueprint_id uuid references public.base_billing_blueprints(id) on delete set null,
  template_id uuid,
  sender_account uuid,
  from_address text,
  cc text[] not null default '{}',
  attach_pdf boolean not null default true,
  -- billing_day: send the drafts made on the cutoff (true) or wait until someone marks them sent (false)
  send_drafts boolean not null default true,
  owner_id uuid default auth.uid(),
  activated_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists base_billing_flows_tenant on public.base_billing_flows (tenant_id, status, position);

create table if not exists public.base_billing_flow_sends (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flow_id uuid references public.base_billing_flows(id) on delete set null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  step text not null,
  to_address text,
  status text not null default 'sent' check (status in ('sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create unique index if not exists base_billing_flow_sends_once on public.base_billing_flow_sends (invoice_id, step) where status = 'sent';
create index if not exists base_billing_flow_sends_flow on public.base_billing_flow_sends (flow_id, created_at desc);

alter table public.invoices add column if not exists entity_id uuid references public.base_billing_entities(id) on delete set null;

-- the company only sees its own rows; the tenant is filled in on insert
do $$
declare t text;
begin
  foreach t in array array['base_billing_entities', 'base_billing_blueprints', 'base_billing_flows', 'base_billing_flow_sends'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    if t = 'base_billing_flow_sends' then
      execute format('create policy tenant_isolation on public.%I for select using (tenant_id = (select current_tenant()))', t);
    else
      execute format('create policy tenant_isolation on public.%I for all using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()))', t);
    end if;
    execute format('drop trigger if exists trg_set_tenant on public.%I', t);
    execute format('create trigger trg_set_tenant before insert on public.%I for each row execute function set_tenant_id()', t);
  end loop;
end $$;

-- every hour: when a workflow is on, billing-flows sends what's due
create or replace function public.base_billing_flows_due()
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare k text; u text; a text;
begin
  if not exists (select 1 from public.base_billing_flows where status = 'active') then return null; end if;
  select key, functions_url, anon_key into k, u, a from public.cs_cron_key where id = 1;
  if k is null or u is null or a is null then return null; end if;
  return net.http_post(
    url := u || '/billing-flows',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || a, 'x-cs-cron', k),
    body := jsonb_build_object('action', 'due'),
    timeout_milliseconds := 150000);
end $$;
revoke all on function public.base_billing_flows_due() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'base-billing-flows') then perform cron.unschedule('base-billing-flows'); end if;
  -- :17 past every hour (the cutoff invoices are made at 04:20 UTC, so they go out at 05:17)
  perform cron.schedule('base-billing-flows', '17 * * * *', 'select public.base_billing_flows_due()');
end $$;
