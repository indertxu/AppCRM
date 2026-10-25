-- =====================================================================
-- 55_pipeline_saves_fast.sql — saving in Settings → Pipelines is instant again
-- =====================================================================
-- 50 and 51 recalculated EVERY contact and company of the company after ANY
-- change to a pipeline or a phase: moving a phase on the canvas, its colour,
-- close %, "show in sales", the order of the list… Each save waited seconds
-- and could hit the database time limit, so the change was not kept.
--
-- The contact / company lists only use two things from pipelines:
--   * the pipeline's name          (the "Pipelines" column / filter)
--   * which phase is the Win phase (sales vs client status)
-- Now a rename just swaps the name in the lists, and a Win flag change
-- recalculates only the contacts and companies with deals in that phase.
-- Everything else (canvas, colours, %, order…) saves straight away.
-- Nothing in your data is changed. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

do $$ begin
  if to_regprocedure('public.cf_refresh(uuid[])') is null or to_regprocedure('public.cof_refresh(uuid[])') is null then
    raise exception 'Run 50_contacts_server.sql and 51_companies_server.sql first.';
  end if;
end $$;

-- the deals touched by a renamed pipeline / a phase whose Win flag changed
create or replace function public.fx_pipe_deals(p_pipes uuid[], p_phases uuid[])
returns table (deal_id uuid, company_id uuid)
language sql stable security definer set search_path = public as $$
  select t.id, t.company_id from public.trackings t where t.pipeline_id = any(coalesce(p_pipes, '{}'))
  union
  select t.id, t.company_id from public.trackings t where t.current_phase_id = any(coalesce(p_phases, '{}'))
$$;
revoke all on function public.fx_pipe_deals(uuid[], uuid[]) from public, anon, authenticated;

-- a renamed pipeline: swap the name inside the stored lists (no recalculation).
-- Returns the pipelines that still need a full recalculation: when another pipeline
-- of the company had the same old name, the lists can't tell them apart.
create or replace function public.fx_pipe_rename(p_tbl text, p_new jsonb, p_old jsonb)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare r record; slow uuid[] := '{}';
begin
  for r in
    select (n.e ->> 'id')::uuid as id, public.cf_row_tenant(n.e) as tenant, o.e ->> 'name' as old_name, n.e ->> 'name' as new_name
    from jsonb_array_elements(p_new) n(e) join jsonb_array_elements(p_old) o(e) on o.e ->> 'id' = n.e ->> 'id'
    where (n.e ->> 'name') is distinct from (o.e ->> 'name')
  loop
    if r.tenant is null or coalesce(r.old_name, '') = '' or coalesce(r.new_name, '') = ''
       or exists (select 1 from public.pipelines p where p.id <> r.id and p.name = r.old_name
                  and public.cf_row_tenant(to_jsonb(p)) = r.tenant) then
      slow := slow || r.id;
      continue;
    end if;
    execute format($q$update public.%I f set pipelines = array(select distinct x from unnest(array_replace(f.pipelines, $1, $2)) x order by 1)
                      where f.tenant_id = $3 and f.pipelines @> array[$1]$q$, p_tbl)
      using r.old_name, r.new_name, r.tenant;
  end loop;
  return slow;
end $$;
revoke all on function public.fx_pipe_rename(text, jsonb, jsonb) from public, anon, authenticated;

-- contacts side
create or replace function public.cf_trg_pipes() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare pipes uuid[]; phases uuid[]; deals uuid[]; cos uuid[];
begin
  if tg_table_name = 'pipelines' then
    if not exists (select 1 from newrows n join oldrows o on o.id = n.id where n.name is distinct from o.name) then return null; end if;
    pipes := public.fx_pipe_rename('contact_facts', (select jsonb_agg(to_jsonb(n)) from newrows n), (select jsonb_agg(to_jsonb(o)) from oldrows o));
  else
    phases := array(select n.id from newrows n join oldrows o on o.id = n.id where n.sales_outcome is distinct from o.sales_outcome);
  end if;
  if coalesce(cardinality(pipes), 0) + coalesce(cardinality(phases), 0) = 0 then return null; end if;
  select array_agg(d.deal_id), array_agg(distinct d.company_id) filter (where d.company_id is not null)
    into deals, cos from public.fx_pipe_deals(pipes, phases) d;
  if deals is null then return null; end if;
  perform public.cf_refresh(array(
    select cc.contact_id from public.company_contacts cc where cc.company_id = any(coalesce(cos, '{}'))
    union
    select tc.contact_id from public.tracking_contacts tc where tc.tracking_id = any(deals)));
  return null;
end $$;

-- companies side
create or replace function public.cof_trg_pipes() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare pipes uuid[]; phases uuid[]; cos uuid[];
begin
  if tg_table_name = 'pipelines' then
    if not exists (select 1 from newrows n join oldrows o on o.id = n.id where n.name is distinct from o.name) then return null; end if;
    pipes := public.fx_pipe_rename('company_facts', (select jsonb_agg(to_jsonb(n)) from newrows n), (select jsonb_agg(to_jsonb(o)) from oldrows o));
  else
    phases := array(select n.id from newrows n join oldrows o on o.id = n.id where n.sales_outcome is distinct from o.sales_outcome);
  end if;
  if coalesce(cardinality(pipes), 0) + coalesce(cardinality(phases), 0) = 0 then return null; end if;
  cos := array(select distinct d.company_id from public.fx_pipe_deals(pipes, phases) d where d.company_id is not null);
  perform public.cof_refresh(cos);
  return null;
end $$;

-- they check the name / Win flag first and stop at once for anything else (canvas moves, colours, %, order…)
drop trigger if exists cf50_pipe_upd   on public.pipelines;
drop trigger if exists cf50_phase_upd  on public.pipeline_phases;
drop trigger if exists cof51_pipe_upd  on public.pipelines;
drop trigger if exists cof51_phase_upd on public.pipeline_phases;
create trigger cf50_pipe_upd   after update on public.pipelines
  referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_pipes();
create trigger cf50_phase_upd  after update on public.pipeline_phases
  referencing new table as newrows old table as oldrows for each statement execute function public.cf_trg_pipes();
create trigger cof51_pipe_upd  after update on public.pipelines
  referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_pipes();
create trigger cof51_phase_upd after update on public.pipeline_phases
  referencing new table as newrows old table as oldrows for each statement execute function public.cof_trg_pipes();

commit;

select 'Pipeline changes save instantly' as done;
