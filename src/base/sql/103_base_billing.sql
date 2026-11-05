-- =====================================================================
-- 103 · BASE · Billing: invoices with lines, work and shipments to bill
-- The Base app's Billing page (src/base/pages/billing):
--   * an invoice belongs to a client (no project, no period): invoices
--     gets client_id / company_id, its own lines (invoice_lines), notes,
--     a tax rate and a "draft" status;
--   * anyone logs work for a client in the calendar (kind 'client_work',
--     billable = hours) or a shipment of a product (kind 'shipment',
--     product_id + quantity + unit price); once billed the entry points
--     at its invoice (calendar_entries.invoice_id), so it isn't billed twice.
-- Who may log work on a client: clients.team ([{userId,name}], already
-- there). Empty team = everyone.
-- Only adds: Enterprise invoices keep project_id + period and never use
-- 'draft'; Base invoices have project_id null, so unique(project_id,
-- period) never bites them.
-- =====================================================================

-- invoices: a client, its lines, notes and tax
alter table public.invoices add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.invoices add column if not exists company_id uuid references public.companies(id) on delete set null;
alter table public.invoices add column if not exists notes text;
alter table public.invoices add column if not exists tax_rate numeric not null default 0;
alter table public.invoices add column if not exists bill_to jsonb not null default '{}'::jsonb;
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check check (status = any (array['draft','sent','paid','void']));
create index if not exists invoices_client_idx on public.invoices (client_id);

create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  sort integer not null default 0,
  description text not null default '',
  quantity numeric not null default 1,
  unit text not null default '',
  unit_price numeric not null default 0,
  product_id uuid references public.products(id) on delete set null,
  service_id uuid references public.services(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoice_lines_invoice_idx on public.invoice_lines (invoice_id);
alter table public.invoice_lines enable row level security;
drop policy if exists tenant_isolation on public.invoice_lines;
create policy tenant_isolation on public.invoice_lines for all
  using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()));
drop trigger if exists trg_set_tenant on public.invoice_lines;
create trigger trg_set_tenant before insert on public.invoice_lines for each row execute function set_tenant_id();

-- calendar: what a shipment sends, and the invoice an entry went on
alter table public.calendar_entries add column if not exists invoice_id uuid references public.invoices(id) on delete set null;
alter table public.calendar_entries add column if not exists product_id uuid references public.products(id) on delete set null;
alter table public.calendar_entries add column if not exists quantity numeric;
alter table public.calendar_entries add column if not exists unit_price numeric;
create index if not exists calendar_entries_unbilled_idx on public.calendar_entries (client_id) where invoice_id is null and kind in ('client_work','shipment');
