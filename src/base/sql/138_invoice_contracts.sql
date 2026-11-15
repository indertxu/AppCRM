-- 138 · Base · Billing → Clients
-- A manual invoice that bills a product the client doesn't have yet opens a new contract
-- (client_products); one that bills a service they don't have opens a new project (projects).
-- Both remember the invoice that created them, so the invoice can show it and a line taken
-- off the invoice (while it's still a draft) takes its contract / project with it.
-- Additive.

alter table public.client_products add column if not exists source_invoice_id uuid references public.invoices(id) on delete set null;
alter table public.projects        add column if not exists source_invoice_id uuid references public.invoices(id) on delete set null;

create index if not exists client_products_source_invoice_idx on public.client_products (source_invoice_id) where source_invoice_id is not null;
create index if not exists projects_source_invoice_idx        on public.projects (source_invoice_id)        where source_invoice_id is not null;

-- Time logged for a client can say which of their services (projects) it was for:
-- calendar_entries.project_id already exists; an index for the client's billing tab.
create index if not exists calendar_entries_project_idx on public.calendar_entries (project_id) where project_id is not null;
