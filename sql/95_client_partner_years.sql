-- Signed client lines that came from a deal with a partner but were written before the deal's
-- calculator kept what the partner takes per year (breakdown.partnerYears). Without it the client
-- page counted those lines at their full price (ARR, contract value, billing), while lines signed
-- later already took the partner off. This fills partnerYears from the deal line, with the same
-- rules the deal calculator uses (salesApi.partnerByPeriod):
--   percent            -> that % of every contract year (minus skipped years)
--   amount, periods    -> that amount (at most the year) in each chosen year
--   amount, no periods -> one cut, in year 1, of at most the whole line
-- Only lines with no partnerYears yet are touched; running it twice changes nothing.
with src as (
  select cp.id,
         coalesce(cp.breakdown->'years', jsonb_build_array(coalesce((cp.breakdown->>'total')::numeric, 0))) as yrs,
         tp.partner_mode, tp.partner_value::numeric as v, tp.partner_periods as pp
  from client_products cp
  join lateral (
    select * from tracking_products t
    where t.tracking_id = cp.tracking_id and t.product_id = cp.product_id
    order by (t.version_active is true) desc limit 1
  ) tp on true
  where cp.breakdown is not null
    and (cp.breakdown->'partnerYears') is null
    and tp.partner_id is not null and coalesce(tp.partner_value::numeric, 0) <> 0
), cut as (
  select s.id,
    jsonb_agg(
      case
        when s.pp is not null and (
               (s.pp->>'mode' = 'once' and y.i > 1)
            or (s.pp->>'mode' <> 'once' and coalesce(s.pp->'skip', '[]'::jsonb) @> to_jsonb(y.i - 1)))
          then 0
        when s.partner_mode = 'amount' and s.pp is null
          then case when y.i = 1 then least(s.v, (select sum(x::numeric) from jsonb_array_elements_text(s.yrs) x)) else 0 end
        when s.partner_mode = 'amount' then least(s.v, y.amt::numeric)
        else round(y.amt::numeric * least(s.v, 100)) / 100
      end order by y.i) as py
  from src s
  cross join lateral jsonb_array_elements_text(s.yrs) with ordinality as y(amt, i)
  group by s.id
)
update client_products cp
set breakdown = cp.breakdown || jsonb_build_object('partnerYears', cut.py)
from cut where cut.id = cp.id;
