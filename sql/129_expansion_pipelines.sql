-- 129_expansion_pipelines.sql  ·  Upsell and cross-sell pipelines ↔ the client's upsells (one shared id).
--
-- Settings › Pipelines marks a pipeline as Upsell or Cross-sell (pipelines.expansion_kind).
--   • A deal created in (or moved into) such a pipeline, for a company that is a client, creates the client's
--     upsell / cross-sell (Clients and Customer success), linked by client_upsells.deal_id.
--   • An upsell / cross-sell created in Clients or Customer success creates its deal in the first pipeline of
--     that kind (its first open phase), linked the same way.
--   • From then on the deal leads: won / lost / reopened, its name and its value (the products, per year) are
--     copied to the upsell.
-- client_upsells.motion says which it is: 'upsell' (more of what they have) or 'cross_sell' (something new).
-- expansion_backfill(pipeline) links the deals already in a pipeline when it is marked.
-- Additive: two columns, four functions, three triggers.

alter table public.pipelines add column if not exists expansion_kind text;
do $$ begin
  alter table public.pipelines add constraint pipelines_expansion_kind_chk check (expansion_kind is null or expansion_kind in ('upsell', 'cross_sell'));
exception when duplicate_object then null; end $$;

alter table public.client_upsells add column if not exists motion text not null default 'upsell';
do $$ begin
  alter table public.client_upsells add constraint client_upsells_motion_chk check (motion in ('upsell', 'cross_sell'));
exception when duplicate_object then null; end $$;
create index if not exists ix129_client_upsells_deal on public.client_upsells (deal_id) where deal_id is not null;

-- a deal's value per year (its active products)
create or replace function public.exp_deal_value(p_deal uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(coalesce(tp.price, 0) * coalesce(nullif(tp.quantity, 0), 1) * case when tp.period = 'monthly' then 12 else 1 end), 0)
    from public.tracking_products tp
   where tp.tracking_id = p_deal and coalesce(tp.version_active, true)
$$;

-- deal → upsell: a client's deal in an upsell / cross-sell pipeline gets its upsell (true when one was made)
create or replace function public.exp_link_deal(p_deal uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  t record;
  v_kind text;
  v_client uuid;
  v_val numeric;
begin
  if exists (select 1 from public.client_upsells where deal_id = p_deal) then return false; end if;
  select * into t from public.trackings where id = p_deal;
  if t.id is null or t.company_id is null then return false; end if;
  select expansion_kind into v_kind from public.pipelines where id = t.pipeline_id;
  if v_kind is null then return false; end if;
  select c.id into v_client from public.clients c
   where c.company_id = t.company_id and c.tenant_id = t.tenant_id
   order by (c.status = 'active') desc nulls last, c.created_at limit 1;
  if v_client is null then return false; end if;
  v_val := public.exp_deal_value(t.id);
  if v_val = 0 then v_val := coalesce(t.product_price, 0); end if;
  perform set_config('app.exp_sync', '1', true);
  insert into public.client_upsells (tenant_id, client_id, motion, kind, product_id, title, est_value, status, deal_id, owner_id, created_by, won_at)
  values (t.tenant_id, v_client, v_kind, case when t.product_id is not null then 'product' else 'other' end, t.product_id,
          coalesce(nullif(trim(t.deal_name), ''), (select name from public.pipelines where id = t.pipeline_id), 'Deal'),
          v_val, case t.status when 'won' then 'won' when 'lost' then 'lost' else 'proposal' end, t.id,
          coalesce((select profile_id from public.tracking_employees where tracking_id = t.id and is_owner limit 1), (select id from public.profiles where id = t.created_by)),
          (select id from public.profiles where id = t.created_by),
          case when t.status = 'won' then coalesce(t.close_date, current_date) end);
  perform set_config('app.exp_sync', '', true);
  return true;
end $$;

-- the deal leads: won / lost / reopened, its name and its pipeline's kind go to its upsell
create or replace function public.exp_sync_deal() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kind text; v_status text;
begin
  if coalesce(current_setting('app.exp_sync', true), '') = '1' then return new; end if;
  if exists (select 1 from public.client_upsells where deal_id = new.id) then
    select expansion_kind into v_kind from public.pipelines where id = new.pipeline_id;
    v_status := case new.status when 'won' then 'won' when 'lost' then 'lost' else null end;
    perform set_config('app.exp_sync', '1', true);
    update public.client_upsells u set
      status = coalesce(v_status, case when u.status in ('won', 'lost') then 'proposal' else u.status end),
      won_at = case when new.status = 'won' then coalesce(u.won_at, new.close_date, current_date) else null end,
      title = case when tg_op = 'UPDATE' and new.deal_name is distinct from old.deal_name and nullif(trim(new.deal_name), '') is not null then trim(new.deal_name) else u.title end,
      motion = coalesce(v_kind, u.motion),
      updated_at = now()
    where u.deal_id = new.id;
    perform set_config('app.exp_sync', '', true);
  else
    perform public.exp_link_deal(new.id);
  end if;
  return new;
exception when others then
  perform set_config('app.exp_sync', '', true);
  return new;  -- linking never stops a deal
end $$;

drop trigger if exists trg129_exp_deal on public.trackings;
create trigger trg129_exp_deal after insert or update of pipeline_id, company_id, status, deal_name on public.trackings
  for each row execute function public.exp_sync_deal();

-- the deal's products → the upsell's value
create or replace function public.exp_sync_value() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_deal uuid := coalesce(new.tracking_id, old.tracking_id); v_val numeric;
begin
  if not exists (select 1 from public.client_upsells where deal_id = v_deal) then return null; end if;
  v_val := public.exp_deal_value(v_deal);
  if v_val > 0 then update public.client_upsells set est_value = v_val, updated_at = now() where deal_id = v_deal and est_value is distinct from v_val; end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists trg129_exp_value on public.tracking_products;
create trigger trg129_exp_value after insert or update or delete on public.tracking_products
  for each row execute function public.exp_sync_value();

-- upsell → deal: an upsell / cross-sell made in Clients or Customer success gets its deal
create or replace function public.exp_upsell_deal() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pipe uuid;
  v_phase uuid;
  v_company uuid;
  v_deal uuid;
begin
  if new.deal_id is not null or coalesce(current_setting('app.exp_sync', true), '') = '1' then return new; end if;
  if new.status in ('won', 'lost') then return new; end if;
  new.tenant_id := coalesce(new.tenant_id, public.current_tenant());  -- this runs before trg_set_tenant
  select id into v_pipe from public.pipelines
   where tenant_id = new.tenant_id and expansion_kind = new.motion
   order by sort_order nulls last, created_at limit 1;
  if v_pipe is null then return new; end if;
  select company_id into v_company from public.clients where id = new.client_id;
  if v_company is null then return new; end if;
  select id into v_phase from public.pipeline_phases
   where pipeline_id = v_pipe and sales_outcome is null
   order by pos_x nulls last, created_at limit 1;
  perform set_config('app.exp_sync', '1', true);
  insert into public.trackings (tenant_id, company_id, pipeline_id, current_phase_id, status, deal_name, product_id, product_price, created_by)
  values (new.tenant_id, v_company, v_pipe, v_phase, 'active', nullif(trim(new.title), ''), new.product_id, nullif(new.est_value, 0),
          coalesce(new.owner_id, auth.uid(), new.created_by))
  returning id into v_deal;
  if new.product_id is not null then
    insert into public.tracking_products (tenant_id, tracking_id, product_id, price, tier_id)
    values (new.tenant_id, v_deal, new.product_id, coalesce(new.est_value, 0), new.tier_id);
  end if;
  -- the upsell's owner owns the deal
  if coalesce(new.owner_id, auth.uid()) is not null then
    insert into public.tracking_employees (tenant_id, tracking_id, profile_id, is_owner)
    values (new.tenant_id, v_deal, coalesce(new.owner_id, auth.uid()), true);
  end if;
  perform set_config('app.exp_sync', '', true);
  new.deal_id := v_deal;
  if new.status in ('idea', 'planned') then new.status := 'proposal'; end if;
  return new;
exception when others then
  perform set_config('app.exp_sync', '', true);
  return new;  -- no deal, but the upsell is kept
end $$;
drop trigger if exists trg129_exp_upsell on public.client_upsells;
create trigger trg129_exp_upsell before insert or update of motion on public.client_upsells
  for each row execute function public.exp_upsell_deal();

-- a pipeline marked upsell / cross-sell: link the deals already in it (clients only). Returns how many.
create or replace function public.expansion_backfill(p_pipeline uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer := 0; r record;
begin
  for r in select t.id from public.trackings t
           where t.pipeline_id = p_pipeline and t.tenant_id = public.current_tenant()
             and not exists (select 1 from public.client_upsells u where u.deal_id = t.id)
  loop
    begin
      if public.exp_link_deal(r.id) then v_n := v_n + 1; end if;
    exception when others then perform set_config('app.exp_sync', '', true);
    end;
  end loop;
  return v_n;
end $$;
grant execute on function public.expansion_backfill(uuid) to authenticated;

-- the deal's owner owns its upsell
create or replace function public.exp_sync_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_owner and coalesce(current_setting('app.exp_sync', true), '') <> '1' then
    update public.client_upsells set owner_id = new.profile_id, updated_at = now()
     where deal_id = new.tracking_id and owner_id is distinct from new.profile_id;
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists trg129_exp_owner on public.tracking_employees;
create trigger trg129_exp_owner after insert or update of is_owner on public.tracking_employees
  for each row execute function public.exp_sync_owner();
