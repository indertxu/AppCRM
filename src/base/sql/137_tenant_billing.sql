-- 137 · Base · Settings › Your account › Your company
-- What a customer company of Next is billed under (one or more legal entities / tax IDs),
-- and the history of what Next billed it for the CRM (users, price per user, discount, VAT…).
-- Read and kept by the company's boss (or an org superadmin); invoices are written by the
-- platform superadmins only. Additive.

create or replace function public.tenant_billing_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select lower(coalesce(role, '')) = 'boss' or coalesce(is_org_superadmin, false) from profiles where id = auth.uid()), false);
$$;
grant execute on function public.tenant_billing_manager() to authenticated;

-- ---------- who the company is billed as (several allowed) ----------
create table if not exists public.tenant_billing_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.current_tenant() references public.tenants(id) on delete cascade,
  legal_name text not null,
  tax_id text not null,
  email text,
  phone text,
  street text,
  postal_code text,
  city text,
  province text,
  country text default 'Spain',
  iban text,
  po_reference text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tenant_billing_entities_tenant_idx on public.tenant_billing_entities (tenant_id);
alter table public.tenant_billing_entities enable row level security;

drop policy if exists tbe_read on public.tenant_billing_entities;
create policy tbe_read on public.tenant_billing_entities for select
  using ((tenant_id = (select public.current_tenant()) and (select public.tenant_billing_manager())) or (select public.is_superadmin()));
drop policy if exists tbe_write on public.tenant_billing_entities;
create policy tbe_write on public.tenant_billing_entities for all
  using ((tenant_id = (select public.current_tenant()) and (select public.tenant_billing_manager())) or (select public.is_superadmin()))
  with check ((tenant_id = (select public.current_tenant()) and (select public.tenant_billing_manager())) or (select public.is_superadmin()));

-- one default per company
create or replace function public.tbe_one_default() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.is_default then
    update public.tenant_billing_entities set is_default = false
     where tenant_id = new.tenant_id and id <> new.id and is_default;
  end if;
  return new;
end $$;
drop trigger if exists trg137_tbe_default on public.tenant_billing_entities;
create trigger trg137_tbe_default before insert or update on public.tenant_billing_entities
  for each row execute function public.tbe_one_default();

-- ---------- what Next billed the company ----------
create table if not exists public.tenant_subscription_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entity_id uuid references public.tenant_billing_entities(id) on delete set null,
  number text not null,
  issued_on date not null default current_date,
  period_start date,
  period_end date,
  due_on date,
  plan text,
  users integer not null default 0,
  price_per_user numeric(12, 2) not null default 0,
  discount_pct numeric(5, 2) not null default 0,
  net numeric(12, 2) not null default 0,
  vat_pct numeric(5, 2) not null default 21,
  vat numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  currency text not null default 'EUR',
  status text not null default 'pending' check (status in ('pending', 'paid', 'overdue', 'void', 'refunded')),
  paid_on date,
  -- who it was billed to, as it was on the day (the entity can change later)
  bill_to_name text,
  bill_to_tax_id text,
  bill_to_address text,
  lines jsonb not null default '[]'::jsonb,
  pdf_url text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists tenant_subscription_invoices_tenant_idx on public.tenant_subscription_invoices (tenant_id, issued_on desc);
alter table public.tenant_subscription_invoices enable row level security;

drop policy if exists tsi_read on public.tenant_subscription_invoices;
create policy tsi_read on public.tenant_subscription_invoices for select
  using ((tenant_id = (select public.current_tenant()) and (select public.tenant_billing_manager())) or (select public.is_superadmin()));
drop policy if exists tsi_write on public.tenant_subscription_invoices;
create policy tsi_write on public.tenant_subscription_invoices for all
  using ((select public.is_superadmin())) with check ((select public.is_superadmin()));
