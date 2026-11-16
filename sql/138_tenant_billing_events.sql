-- =====================================================================
-- 138 · Enterprise · Company billing: one record, two sides, and each side
-- hears about the other's changes.
--
-- The billing data itself is SQL 137 (tenant_billing_entities = who the
-- company is billed as; tenant_subscription_invoices = what Next billed).
-- The company's owner edits it in Settings › Your account, Next's
-- superadmins in the platform console › a company › Billing: the same rows,
-- so both sides always show the same thing.
--
-- New here:
--   • tenant_billing_events — every change to those two tables, written by
--     triggers: who (client or Next, and the person), what (added / changed /
--     removed / default), which record and which fields.
--   • tenant_billing_seen — up to when each person has looked at a company's
--     billing (so "N new changes" can be shown to the other side).
--   • when Next changes something, the company's owners (role boss) get a
--     Home notification (user_alerts, kind billing_next).
--   • both tables in supabase_realtime, so an open page updates by itself.
-- Additive, safe to run more than once. Nothing is dropped.
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.tenant_billing_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  side text not null check (side in ('client', 'next')),
  actor_id uuid,
  actor_name text,
  kind text not null,          -- entity_added | entity_changed | entity_removed | entity_default | invoice_added | invoice_changed | invoice_removed
  ref_id uuid,
  label text,                  -- the entity's legal name / the invoice number
  fields text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists tenant_billing_events_tenant_idx on public.tenant_billing_events (tenant_id, created_at desc);
create index if not exists tenant_billing_events_side_idx on public.tenant_billing_events (side, created_at desc);
alter table public.tenant_billing_events enable row level security;
drop policy if exists tbev_read on public.tenant_billing_events;
create policy tbev_read on public.tenant_billing_events for select to authenticated
  using ((tenant_id = (select public.current_tenant()) and (select public.tenant_billing_manager())) or (select public.is_superadmin()));
grant select on public.tenant_billing_events to authenticated;

create table if not exists public.tenant_billing_seen (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  seen_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
alter table public.tenant_billing_seen enable row level security;
drop policy if exists tbs_own on public.tenant_billing_seen;
create policy tbs_own on public.tenant_billing_seen for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and (tenant_id = (select public.current_tenant()) or (select public.is_superadmin())));
grant select, insert, update on public.tenant_billing_seen to authenticated;

/* One event per change, from either table. Never fails the change itself. */
create or replace function public.tenant_billing_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r jsonb := coalesce(n, o);
  is_inv boolean := tg_table_name = 'tenant_subscription_invoices';
  v_side text := case when public.is_superadmin() then 'next' else 'client' end;
  v_kind text;
  v_fields text[] := '{}';
  v_name text;
  v_label text;
  v_tenant uuid := (r->>'tenant_id')::uuid;
  b record;
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}') into v_fields
      from jsonb_object_keys(n) k
     where k not in ('updated_at', 'created_at') and (o->k) is distinct from (n->k);
    if cardinality(v_fields) = 0 then return null; end if;
    -- the other entities losing their star when one gets it: a side effect, not a change
    if not is_inv and v_fields = array['is_default'] then
      if (n->>'is_default')::boolean then v_kind := 'entity_default'; else return null; end if;
    end if;
  end if;
  v_kind := coalesce(v_kind, (case when is_inv then 'invoice_' else 'entity_' end)
    || case tg_op when 'INSERT' then 'added' when 'UPDATE' then 'changed' else 'removed' end);
  v_label := case when is_inv then r->>'number' else r->>'legal_name' end;
  select nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '') into v_name from profiles where id = auth.uid();
  v_name := coalesce(v_name, (select email from profiles where id = auth.uid()));

  begin
    insert into public.tenant_billing_events (tenant_id, side, actor_id, actor_name, kind, ref_id, label, fields)
    values (v_tenant, v_side, auth.uid(), v_name, v_kind, (r->>'id')::uuid, v_label, v_fields);

    -- Next changed something: tell the company's owners on Home
    if v_side = 'next' and to_regclass('public.user_alerts') is not null then
      for b in select id from profiles where tenant_id = v_tenant and lower(coalesce(role, '')) = 'boss' and coalesce(active, true) loop
        insert into public.user_alerts (tenant_id, user_id, kind, title, body, ref_type, ref_id, actor_id)
        values (v_tenant, b.id, 'billing_next',
          case v_kind
            when 'invoice_added' then 'New invoice ' || coalesce(v_label, '')
            when 'invoice_changed' then 'Invoice ' || coalesce(v_label, '') || ' updated'
            when 'invoice_removed' then 'Invoice ' || coalesce(v_label, '') || ' removed'
            when 'entity_added' then coalesce(v_label, 'A billing entity') || ' added'
            when 'entity_removed' then coalesce(v_label, 'A billing entity') || ' removed'
            when 'entity_default' then coalesce(v_label, 'An entity') || ' is now the default'
            else coalesce(v_label, 'Your billing details') || ' updated' end,
          'Next updated your company billing', 'billing', (r->>'id')::uuid, auth.uid());
      end loop;
    end if;
  exception when others then
    raise warning 'tenant_billing_log: %', sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists trg138_tbe_log on public.tenant_billing_entities;
create trigger trg138_tbe_log after insert or update or delete on public.tenant_billing_entities
  for each row execute function public.tenant_billing_log();
drop trigger if exists trg138_tsi_log on public.tenant_subscription_invoices;
create trigger trg138_tsi_log after insert or update or delete on public.tenant_subscription_invoices
  for each row execute function public.tenant_billing_log();

-- open pages update by themselves
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['tenant_billing_events', 'tenant_billing_entities', 'tenant_subscription_invoices'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

commit;
