-- =====================================================================
-- 110 · BASE · Where a draft came from, and who issues the invoices
--   invoices.source         — 'manual' (written or made by someone) or
--                             'auto' (made by the system: automatic run /
--                             Bill now); Billing › To invoice tells them apart
--   base_billing_settings   — the issuer printed on invoices and put in the
--                             XML export (Facturae): name, tax id, address,
--                             IBAN, e-mail
--   base_bill_up_to         — the invoices it makes are 'auto'
-- Only adds (Enterprise invoices get 'manual' and never read it).
-- =====================================================================
alter table public.invoices add column if not exists source text not null default 'manual';
alter table public.invoices drop constraint if exists invoices_source_check;
alter table public.invoices add constraint invoices_source_check check (source in ('manual', 'auto'));

alter table public.base_billing_settings add column if not exists seller_name text;
alter table public.base_billing_settings add column if not exists seller_tax_id text;
alter table public.base_billing_settings add column if not exists seller_street text;
alter table public.base_billing_settings add column if not exists seller_postal_code text;
alter table public.base_billing_settings add column if not exists seller_city text;
alter table public.base_billing_settings add column if not exists seller_province text;
alter table public.base_billing_settings add column if not exists seller_country text not null default 'ES';
alter table public.base_billing_settings add column if not exists seller_iban text;
alter table public.base_billing_settings add column if not exists seller_email text;

-- what the system already made
update public.invoices set source = 'auto'
where project_id is null and source = 'manual' and notes like 'Work and shipments up to %';

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
    insert into invoices (tenant_id, number, client_id, company_id, period, status, issue_date, due_date, sent_date, net, amount, days, tax_rate, bill_to, notes, source)
    values (p_tenant, yr || '-' || lpad(num::text, 4, '0'), c.id, c.company_id, to_char(p_cutoff, 'YYYY-MM'),
      case when p_send then 'sent' else 'draft' end, current_date, current_date + coalesce(nullif(c.payment_days, 0), 30),
      case when p_send then current_date end, 0, 0, 0, v_tax,
      jsonb_build_object('name', c.name, 'legal_name', coalesce(c.legal_name, c.name), 'vat', coalesce(c.vat_number, ''), 'email', coalesce(c.email, ''),
        'address', concat_ws(', ', nullif(concat_ws(' ', c.street, c.addr_number), ''), nullif(concat_ws(' ', c.postal_code, c.city), ''), c.country)),
      'Work and shipments up to ' || to_char(p_cutoff, 'FMDD Month YYYY'), 'auto')
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
