-- 22_invoice_sent_dates.sql
-- Until now "Mark as sent" saved the period's cutoff date (shifted one day back
-- by a UTC bug) instead of the day you actually sent it. This sets each sent or
-- paid invoice's sent_date to the day it was really marked as sent (from the
-- status history, Madrid time) and moves its due date by the same number of days.
-- Run PART 1 first to preview; run PART 2 to apply.

-- PART 1 · preview -----------------------------------------------------------
with last_sent as (
  select distinct on (l.invoice_id)
         l.invoice_id,
         (l.created_at at time zone 'Europe/Madrid')::date as real_sent
  from invoice_status_log l
  where l.invoice_id is not null and l.to_status = 'sent' and coalesce(l.from_status, 'tobill') = 'tobill'
  order by l.invoice_id, l.created_at desc
)
select i.id, i.project_id, i.period, i.sent_date as old_sent, ls.real_sent as new_sent,
       i.due_date as old_due, (i.due_date + (ls.real_sent - i.sent_date)) as new_due, i.status
from invoices i
join last_sent ls on ls.invoice_id = i.id
where i.sent_date is not null and i.sent_date <> ls.real_sent
order by ls.real_sent desc;

-- PART 2 · apply -------------------------------------------------------------
-- with last_sent as (
--   select distinct on (l.invoice_id)
--          l.invoice_id,
--          (l.created_at at time zone 'Europe/Madrid')::date as real_sent
--   from invoice_status_log l
--   where l.invoice_id is not null and l.to_status = 'sent' and coalesce(l.from_status, 'tobill') = 'tobill'
--   order by l.invoice_id, l.created_at desc
-- )
-- update invoices i
-- set due_date  = case when i.due_date is null then null else i.due_date + (ls.real_sent - i.sent_date) end,
--     sent_date = ls.real_sent
-- from last_sent ls
-- where ls.invoice_id = i.id and i.sent_date is not null and i.sent_date <> ls.real_sent;
