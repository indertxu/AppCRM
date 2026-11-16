-- 143 · Base · Billing: the month's cutoff can be "N days before the month ends".
-- base_billing_settings.cutoff_day:  0 = last day of the month
--                                    1..28 = that day of the month
--                                   -1..-27 = that many days before the last day (-10 on 30 Nov → 20 Nov)
-- Widens the check and teaches base_cutoff_of the negative values. Existing values keep their meaning.

alter table public.base_billing_settings drop constraint if exists base_billing_settings_cutoff_day_check;
alter table public.base_billing_settings add constraint base_billing_settings_cutoff_day_check check (cutoff_day between -27 and 28);

create or replace function public.base_cutoff_of(d date, cday integer)
 returns date language sql immutable as $function$
  select case
    when coalesce(cday, 0) = 0 then (date_trunc('month', d) + interval '1 month - 1 day')::date
    when cday < 0 then ((date_trunc('month', d) + interval '1 month - 1 day')::date + cday)
    else make_date(extract(year from d)::int, extract(month from d)::int, least(cday, 28)) end
$function$;
