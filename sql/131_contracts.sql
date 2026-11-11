-- 131_contracts.sql  ·  Contracts as a catalogue item and as a line on a deal.
--
-- contract_templates: Settings › Catalog › Contracts — a contract blueprint, like a product or a service:
--   its terms (length in days / months / years, renewal), a discount per length, the ways to pay (each with its
--   early-payment discount), when it is invoiced (days before it starts / renews), the yearly increments (and
--   whether paying upfront waives them) and named commercial discounts. All of it in `config` (jsonb).
-- tracking_contracts: a contract on a deal (the deal's calculator: Products · Services · Contracts). It can carry
--   products — counted at what their calculator gives, without the product's own discounts, term or increments:
--   the contract's apply — or none (a fee of its own). `data` holds it; total / first_year are what it comes to.
-- Additive: two tables with tenant RLS.

create table if not exists public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.current_tenant(),
  name text not null default 'New contract',
  description text,
  active boolean not null default true,
  in_proposals boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.contract_templates enable row level security;
do $$ begin
  create policy contract_templates_tenant on public.contract_templates for all
    using (tenant_id = (select public.current_tenant())) with check (tenant_id = (select public.current_tenant()));
exception when duplicate_object then null; end $$;

create table if not exists public.tracking_contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.current_tenant(),
  tracking_id uuid not null references public.trackings(id) on delete cascade,
  template_id uuid references public.contract_templates(id) on delete set null,
  name text not null default 'Contract',
  data jsonb not null default '{}'::jsonb,
  total numeric not null default 0,
  first_year numeric not null default 0,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix130_tracking_contracts_deal on public.tracking_contracts (tracking_id);
alter table public.tracking_contracts enable row level security;
do $$ begin
  create policy tracking_contracts_tenant on public.tracking_contracts for all
    using (tenant_id = (select public.current_tenant())) with check (tenant_id = (select public.current_tenant()));
exception when duplicate_object then null; end $$;
