-- 136_contract_groups.sql — Clients › Contracts: contracts of one client grouped under a main one
--
-- Each contract keeps its own dates, products and figures; the group shows as one
-- contract (the main one's name, a counter): the running ones' yearly values added
-- up, the first start and the last end. One row per contract that sits inside
-- another (the main one has no row of its own).
--
-- A contract's key: "t:<deal id>" (a deal's contract, or the products signed on
-- that deal), or "l:<client id>|none" for products signed by hand without a deal.
--
-- Safe to run twice.

create table if not exists public.contract_groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  client_id   uuid references public.clients (id) on delete cascade,
  main_key    text not null,
  member_key  text not null,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create unique index if not exists contract_groups_member on public.contract_groups (tenant_id, member_key);
create index if not exists contract_groups_main on public.contract_groups (tenant_id, main_key);

drop trigger if exists trg_set_tenant on public.contract_groups;
create trigger trg_set_tenant before insert on public.contract_groups for each row execute function public.set_tenant_id();

alter table public.contract_groups enable row level security;
drop policy if exists tenant_isolation on public.contract_groups;
create policy tenant_isolation on public.contract_groups for all to authenticated
  using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()));
grant select, insert, update, delete on public.contract_groups to authenticated;
