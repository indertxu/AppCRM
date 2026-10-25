-- =====================================================================
-- 60_calc_price_editable.sql — calculator inputs whose price sales can change on the deal
-- =====================================================================
-- Settings › Products & services › a calculator input › "On the deal: Fixed / Editable".
-- Editable: in a deal's calculator, sales can type another price per unit /
-- per block / amount / % for that input; the deal keeps it (the catalogue
-- price doesn't change). Nothing is deleted. Safe to run more than once.
-- =====================================================================
alter table public.calculator_variables add column if not exists price_editable boolean not null default false;
notify pgrst, 'reload schema';
select count(*) filter (where price_editable) as editable_inputs, count(*) as inputs from public.calculator_variables;
