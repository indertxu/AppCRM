-- =====================================================================
-- 87_platform_costs.sql — real costs, pulled from the providers' APIs
--
-- The manage-tenants edge function (action "sync_costs") reads, with keys kept
-- as Edge Function secrets:
--   Supabase Management API  plan, projects in the org, compute add-ons (prices)
--   Anthropic Cost API       what Claude actually cost, per day and model
--   Vercel billing API       hosting charges, per day and service
--   Resend API               e-mails sent (Resend has no billing API)
-- and writes them here. The console reads them with sa_costs().
-- =====================================================================

create table if not exists public.platform_cost_daily (
  day        date not null,
  provider   text not null,
  item       text not null,
  amount_usd numeric not null default 0,
  quantity   numeric,
  unit       text,
  primary key (day, provider, item)
);
alter table public.platform_cost_daily enable row level security;
drop policy if exists "pcd superadmin read" on public.platform_cost_daily;
create policy "pcd superadmin read" on public.platform_cost_daily for select to authenticated using (public.is_superadmin());

create table if not exists public.platform_cost_sources (
  provider  text primary key,
  status    text not null default 'missing' check (status in ('ok', 'error', 'missing')),
  message   text,
  synced_at timestamptz,
  monthly   jsonb not null default '{}'::jsonb
);
alter table public.platform_cost_sources enable row level security;
drop policy if exists "pcs superadmin read" on public.platform_cost_sources;
create policy "pcs superadmin read" on public.platform_cost_sources for select to authenticated using (public.is_superadmin());
-- written only by the edge function (service role)

create or replace function public.sa_costs(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  d integer := greatest(1, least(coalesce(p_days, 30), 365));
  since date := current_date - (d - 1);
begin
  if not public.is_superadmin() then raise exception 'Only a superadmin can read this'; end if;
  return jsonb_build_object(
    'since', since,
    'sources', coalesce((select jsonb_agg(to_jsonb(s) order by s.provider) from public.platform_cost_sources s), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(to_jsonb(c) order by c.day) from public.platform_cost_daily c where c.day >= since), '[]'::jsonb)
  );
end $$;
revoke all on function public.sa_costs(integer) from public, anon;
grant execute on function public.sa_costs(integer) to authenticated;
