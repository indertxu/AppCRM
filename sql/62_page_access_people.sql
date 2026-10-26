-- =====================================================================
-- 62_page_access_people.sql — let named people into a page
-- =====================================================================
-- Page access (Settings → Organization) lists, per page, the departments that
-- can open it. This adds the exceptions: people from other departments who
-- may open the page too. Run 61_custom_departments.sql first.
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
alter table public.page_departments add column if not exists user_ids text[] not null default '{}';
notify pgrst, 'reload schema';
commit;

select page, dept_keys, user_ids from public.page_departments order by page;
