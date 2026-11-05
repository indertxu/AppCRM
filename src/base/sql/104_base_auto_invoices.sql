-- =====================================================================
-- 104 · BASE · Automatic invoices on the month's cutoff
-- Billing › Automatic invoices (src/base/pages/billing/AutoInvoiceModal):
-- on (cutoff_day: 0 = last day of the month, else that day), the day after
-- each cutoff every client with unbilled client work / shipments up to the
-- cutoff gets one invoice (draft to review, or sent at once).
--   base_billing_settings — per tenant: on/off, cutoff day, draft or sent
--   base_billing_runs     — every run (auto or "Bill now"), so a cutoff is
--                           only billed automatically once
--   base_bill_up_to(...)  — internal: makes the invoices (not callable)
--   base_bill_now(date)   — "Bill now" for the signed-in user's company
--   base_billing_tick()   — daily (pg_cron "base-auto-invoices", 04:20 UTC)
--                           for every company; for the signed-in user's own
--                           when the Billing page opens (in case cron missed)
-- An hour bills at the client's price_per_day ÷ 8, else the hourly service's
-- price, else the daily one ÷ 8 (as billingApi.hourlyRate). Base only:
-- Enterprise doesn't read these tables.
-- =====================================================================

create table if not exists public.base_billing_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  auto_invoice boolean not null default false,
  cutoff_day integer not null default 0 check (cutoff_day between 0 and 28),
  auto_send boolean not null default false,
  enabled_on date,
  updated_at timestamptz not null default now()
);
alter table public.base_billing_settings enable row level security;
drop policy if exists tenant_isolation on public.base_billing_settings;
create policy tenant_isolation on public.base_billing_settings for all
  using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()));
drop trigger if exists trg_set_tenant on public.base_billing_settings;
create trigger trg_set_tenant before insert on public.base_billing_settings for each row execute function set_tenant_id();

create table if not exists public.base_billing_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cutoff date not null,
  auto boolean not null default true,
  invoices integer not null default 0,
  net numeric not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists base_billing_runs_auto_uq on public.base_billing_runs (tenant_id, cutoff) where auto;
alter table public.base_billing_runs enable row level security;
drop policy if exists tenant_read on public.base_billing_runs;
create policy tenant_read on public.base_billing_runs for select using (tenant_id = (select current_tenant()));

-- the cutoff of the month of d (0 = its last day)
create or replace function public.base_cutoff_of(d date, cday integer) returns date
language sql immutable as $$
  select case when coalesce(cday, 0) = 0 then (date_trunc('month', d) + interval '1 month - 1 day')::date
              else make_date(extract(year from d)::int, extract(month from d)::int, least(cday, 28)) end
$$;

-- one invoice per client for everything unbilled up to p_cutoff
create or replace function public.base_bill_up_to(p_tenant uuid, p_cutoff date, p_send boolean, p_user uuid, p_auto boolean)
returns table (n_invoices integer, total_net numeric)
language plpgsql security definer set search_path = public as $$
declare
  c record; ln record; inv uuid; yr int := extract(year from current_date)::int; num int; n int := 0; tot numeric := 0;
  svc_h numeric; svc_d numeric; rate numeric; s int; v_net numeric; v_tax numeric;
begin
  select price into svc_h from services where tenant_id = p_tenant and billing = 'hourly' and price > 0 and active is not false order by name limit 1;
  select price into svc_d from services where tenant_id = p_tenant and billing = 'daily' and price > 0 and active is not false order by name limit 1;
  select coalesce(max((regexp_match(number, '^\d{4}-(\d+)$'))[1]::int), 0) into num
    from invoices where tenant_id = p_tenant and project_id is null and number like yr || '-%';

  for c in
    select cl.id, cl.name, cl.price_per_day, cl.taxed, cl.tax_rate, cl.payment_days, cl.company_id,
           co.legal_name, co.vat_number, co.email, co.street, co.addr_number, co.postal_code, co.city, co.country
    from clients cl left join companies co on co.id = cl.company_id
    where cl.tenant_id = p_tenant and exists (
      select 1 from calendar_entries e where e.client_id = cl.id and e.invoice_id is null and e.kind in ('client_work', 'shipment')
        and e.entry_date <= p_cutoff and e.status <> 'cancelled')
    order by cl.name
  loop
    rate := case when coalesce(c.price_per_day, 0) > 0 then round(c.price_per_day / 8, 2) else coalesce(svc_h, round(svc_d / 8, 2), 0) end;
    v_tax := case when c.taxed is false then 0 else coalesce(c.tax_rate, 21) end;
    num := num + 1;
    insert into invoices (tenant_id, number, client_id, company_id, period, status, issue_date, due_date, sent_date, net, amount, days, tax_rate, bill_to, notes)
    values (p_tenant, yr || '-' || lpad(num::text, 4, '0'), c.id, c.company_id, to_char(p_cutoff, 'YYYY-MM'),
      case when p_send then 'sent' else 'draft' end, current_date, current_date + coalesce(nullif(c.payment_days, 0), 30),
      case when p_send then current_date end, 0, 0, 0, v_tax,
      jsonb_build_object('name', c.name, 'legal_name', coalesce(c.legal_name, c.name), 'vat', coalesce(c.vat_number, ''), 'email', coalesce(c.email, ''),
        'address', concat_ws(', ', nullif(concat_ws(' ', c.street, c.addr_number), ''), nullif(concat_ws(' ', c.postal_code, c.city), ''), c.country)),
      'Work and shipments up to ' || to_char(p_cutoff, 'FMDD Month YYYY'))
    returning id into inv;

    s := 0;
    for ln in
      select e.user_id, sum(e.billable) h, min(e.entry_date) a, max(e.entry_date) b,
             coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.username, 'Team') who
      from calendar_entries e left join profiles p on p.id = e.user_id
      where e.client_id = c.id and e.invoice_id is null and e.kind = 'client_work' and e.entry_date <= p_cutoff and e.status <> 'cancelled'
      group by e.user_id, p.first_name, p.last_name, p.username order by 5
    loop
      insert into invoice_lines (tenant_id, invoice_id, sort, description, quantity, unit, unit_price, user_id)
      values (p_tenant, inv, s, 'Work · ' || ln.who || ' (' || to_char(ln.a, 'FMDD Mon') ||
        case when ln.a = ln.b then '' else ' – ' || to_char(ln.b, 'FMDD Mon') end || ')', round(ln.h, 2), 'h', rate, ln.user_id);
      s := s + 1;
    end loop;
    for ln in
      select e.*, pr.name pname,
        (select t.price from product_tiers t where t.product_id = e.product_id order by t.sort limit 1) tprice
      from calendar_entries e left join products pr on pr.id = e.product_id
      where e.client_id = c.id and e.invoice_id is null and e.kind = 'shipment' and e.entry_date <= p_cutoff and e.status <> 'cancelled'
      order by e.entry_date
    loop
      insert into invoice_lines (tenant_id, invoice_id, sort, description, quantity, unit, unit_price, product_id)
      values (p_tenant, inv, s, coalesce(ln.pname, ln.name, 'Shipment') || ' · shipped ' || to_char(ln.entry_date, 'FMDD Mon'),
        coalesce(ln.quantity, 1), 'unit', coalesce(ln.unit_price, ln.tprice, 0), ln.product_id);
      s := s + 1;
    end loop;

    update calendar_entries set invoice_id = inv
    where client_id = c.id and invoice_id is null and kind in ('client_work', 'shipment') and entry_date <= p_cutoff and status <> 'cancelled';

    select coalesce(sum(round(quantity * unit_price, 2)), 0) into v_net from invoice_lines where invoice_id = inv;
    update invoices set net = v_net, amount = round(v_net * (1 + v_tax / 100), 2) where id = inv;
    n := n + 1; tot := tot + v_net;
  end loop;

  insert into base_billing_runs (tenant_id, cutoff, auto, invoices, net, created_by) values (p_tenant, p_cutoff, p_auto, n, tot, p_user);
  return query select n, tot;
end $$;
revoke all on function public.base_bill_up_to(uuid, date, boolean, uuid, boolean) from public, anon, authenticated;

-- "Bill now": everything up to a day, for the signed-in user's company
create or replace function public.base_bill_now(p_cutoff date, p_send boolean default false)
returns table (n_invoices integer, total_net numeric)
language plpgsql security definer set search_path = public as $$
declare t uuid := current_tenant();
begin
  if t is null then raise exception 'Not signed in'; end if;
  if p_cutoff > current_date then raise exception 'The cutoff can''t be in the future'; end if;
  return query select * from base_bill_up_to(t, p_cutoff, p_send, auth.uid(), false);
end $$;
revoke all on function public.base_bill_now(date, boolean) from public, anon;
grant execute on function public.base_bill_now(date, boolean) to authenticated;

-- daily: the last cutoff before today, once, for every company that switched it on
create or replace function public.base_billing_tick() returns integer
language plpgsql security definer set search_path = public as $$
declare s record; cut date; done int := 0;
begin
  for s in select * from base_billing_settings b
           where b.auto_invoice and (auth.uid() is null or b.tenant_id = current_tenant()) loop
    cut := base_cutoff_of(current_date, s.cutoff_day);
    if cut >= current_date then cut := base_cutoff_of((date_trunc('month', current_date) - interval '1 day')::date, s.cutoff_day); end if;
    -- only cutoffs after it was switched on, once each
    if s.enabled_on is not null and cut < s.enabled_on then continue; end if;
    if exists (select 1 from base_billing_runs r where r.tenant_id = s.tenant_id and r.cutoff = cut and r.auto) then continue; end if;
    perform base_bill_up_to(s.tenant_id, cut, s.auto_send, null, true);
    done := done + 1;
  end loop;
  return done;
end $$;
revoke all on function public.base_billing_tick() from public, anon;
grant execute on function public.base_billing_tick() to authenticated;

select cron.unschedule('base-auto-invoices') where exists (select 1 from cron.job where jobname = 'base-auto-invoices');
select cron.schedule('base-auto-invoices', '20 4 * * *', 'select public.base_billing_tick()');
