-- =====================================================================
-- 48_deals_rls_fast.sql — make deals fast again (fixes the endless loading)
-- =====================================================================
-- Problem: every deal row runs can_see_tracking(), which looks up your
-- profile again for EACH row (~1 ms/row). 9,300 deals > 8 s limit, so
-- contacts, companies, deals, projects and clients never finish loading.
--
-- Fix: the "who am I" part (superadmin / not a sales user) is now worked out
-- ONCE per query. Only users with role 'sales' still get the per-deal check
-- (their own deals + deals they are on). Who sees what does NOT change.
--
-- Applies to every access rule that uses can_see_tracking (deals, deal
-- contacts, notes, files...). Old rules are saved in rls_bk48 for undo:
--   48_deals_rls_fast_undo.sql
-- Safe to run more than once.
-- =====================================================================

-- once per query: does this user see every deal of the tenant?
create or replace function public.sees_all_deals()
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select coalesce((select p.is_superadmin or coalesce(p.role, '') <> 'sales'
                   from profiles p where p.id = auth.uid()), false)
      or public.is_superadmin();
$$;
grant execute on function public.sees_all_deals() to authenticated;

do $$
declare r record; n int := 0; q text; c text;
begin
  create table if not exists public.rls_bk48 (
    tbl text, policy text, qual text, with_check text, at timestamptz default now(),
    primary key (tbl, policy));
  alter table public.rls_bk48 enable row level security;

  for r in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (qual ~ 'can_see_tracking\(' or coalesce(with_check, '') ~ 'can_see_tracking\(')
  loop
    insert into public.rls_bk48 (tbl, policy, qual, with_check)
    values (r.tablename, r.policyname, r.qual, r.with_check)
    on conflict (tbl, policy) do nothing;          -- keep the ORIGINAL on re-runs

    q := r.qual;
    c := r.with_check;
    if q is not null and q !~ 'sees_all_deals' and q ~ 'can_see_tracking\(' then
      q := '(( SELECT sees_all_deals() AS sees_all_deals) OR (' || q || '))';
      execute format('alter policy %I on public.%I using (%s)', r.policyname, r.tablename, q);
    end if;
    if c is not null and c !~ 'sees_all_deals' and c ~ 'can_see_tracking\(' then
      c := '(( SELECT sees_all_deals() AS sees_all_deals) OR (' || c || '))';
      execute format('alter policy %I on public.%I with check (%s)', r.policyname, r.tablename, c);
    end if;
    n := n + 1;
  end loop;
  raise notice 'Sped up % access rules.', n;
end $$;

-- result: the rules as they are now
select tablename as "table", policyname as rule, qual as rule_now
from pg_policies
where schemaname = 'public' and qual ~ 'can_see_tracking\('
order by 1, 2;
