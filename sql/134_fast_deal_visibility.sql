-- 134_fast_deal_visibility.sql
-- A sales rep sees only their deals (created by them or on the deal's team). The rule used to call
-- can_see_tracking() once per row: every page of deals / deal lines / tasks took ~2 s for a rep and
-- the big reads (Reports, Sales) could hit the statement timeout. Now the deals a person can see are
-- worked out once per query (my_visible_tracking_ids) and each row is a quick array check.
-- Same rule as before: anyone who isn't a sales rep (or a superadmin) sees every deal of their tenant.

create or replace function public.my_visible_tracking_ids()
returns uuid[]
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(array_agg(distinct x.id), '{}'::uuid[])
  from (
    select t.id from trackings t where t.created_by = auth.uid()
    union all
    select te.tracking_id from tracking_employees te where te.profile_id = auth.uid() and te.tracking_id is not null
  ) x;
$$;
grant execute on function public.my_visible_tracking_ids() to authenticated;

alter policy team_visibility on public.trackings
  using ((select sees_all_deals()) or id = any ((select my_visible_tracking_ids())::uuid[]));

alter policy team_visibility on public.deal_proposals
  using ((select sees_all_deals()) or tracking_id is null or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_contacts
  using ((select sees_all_deals()) or tracking_id is null or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_employees
  using ((select sees_all_deals()) or tracking_id is null or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_files
  using ((select sees_all_deals()) or tracking_id is null or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_phase_events
  using ((select sees_all_deals()) or tracking_id is null or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_potential_services
  using ((select sees_all_deals()) or tracking_id is null or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_products
  using ((select sees_all_deals()) or tracking_id is null or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_meetings
  using ((select sees_all_deals()) or tracking_id is null or assignee_id = (select auth.uid()) or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_notes
  using ((select sees_all_deals()) or tracking_id is null or assignee_id = (select auth.uid()) or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
alter policy team_visibility on public.tracking_tasks
  using ((select sees_all_deals()) or tracking_id is null or assignee_id = (select auth.uid()) or tracking_id = any ((select my_visible_tracking_ids())::uuid[]));
