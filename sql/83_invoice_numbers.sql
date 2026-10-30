-- =====================================================================
-- 83_invoice_numbers.sql — each invoice keeps its number and date
-- =====================================================================
-- Management › Billing builds the PDF invoice for the client; the number you
-- give it (and the date on it) is kept on the invoice, so the PDF comes out the
-- same later and the next number is suggested from the last one.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;

alter table public.invoices add column if not exists number text;
alter table public.invoices add column if not exists issue_date date;

notify pgrst, 'reload schema';
commit;

select count(*) filter (where number is not null) as numbered_invoices from public.invoices;
