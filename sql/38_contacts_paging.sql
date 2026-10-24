-- =====================================================================
-- 013 · Presentaciones y memorias de las empresas con datos propios
--
-- Almacén propio de la versión de datos propios, separado del de la versión
-- Konsolidator (public.presentations). Mismas reglas:
--   · Cada presentación es de una empresa (company_id) y de quien la crea (owner_id).
--   · Visibilidad: private (solo quien la crea) · company (toda la empresa,
--     lectura) · shared (las personas elegidas, en presentation_shares).
--   · Editan quien la crea y las personas con permiso de edición. Borrar y
--     cambiar visibilidad, dueño o empresa: solo quien la crea.
--   · ledger.pres_company_users(cid): usuarios de la empresa para compartir.
-- Se puede volver a ejecutar.
-- =====================================================================
begin;

create table if not exists ledger.presentations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references accounts.companies(id) on delete cascade,
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_name  text,
  name        text not null default '',
  visibility  text not null default 'private' check (visibility in ('private', 'company', 'shared')),
  doc_type    text not null default 'deck' check (doc_type in ('deck', 'memory')),
  content     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create index if not exists ledger_presentations_company on ledger.presentations (company_id, updated_at desc);
create index if not exists ledger_presentations_owner on ledger.presentations (owner_id);

create table if not exists ledger.presentation_shares (
  presentation_id uuid not null references ledger.presentations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  can_edit        boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (presentation_id, user_id)
);
create index if not exists ledger_presentation_shares_user on ledger.presentation_shares (user_id);

-- Funciones auxiliares (security definer: las políticas de las dos tablas no se llaman en bucle)
create or replace function ledger.pres_is_owner(pid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from ledger.presentations p where p.id = pid and p.owner_id = auth.uid());
$$;

create or replace function ledger.pres_shared_with_me(pid uuid, need_edit boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from ledger.presentation_shares s
                 where s.presentation_id = pid and s.user_id = auth.uid() and (not need_edit or s.can_edit));
$$;

create or replace function ledger.pres_is_member(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select cid in (select ledger.my_company_ids());
$$;

-- updated_at / updated_by automáticos y guarda de dueño, empresa y visibilidad
create or replace function ledger.presentations_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.owner_id <> auth.uid() and (
       new.owner_id   is distinct from old.owner_id
    or new.company_id is distinct from old.company_id
    or new.visibility is distinct from old.visibility) then
    raise exception 'Solo quien crea la presentación puede cambiar su visibilidad';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists presentations_touch on ledger.presentations;
create trigger presentations_touch before update on ledger.presentations
  for each row execute function ledger.presentations_touch();

alter table ledger.presentations       enable row level security;
alter table ledger.presentation_shares enable row level security;
grant select, insert, update, delete on ledger.presentations, ledger.presentation_shares to authenticated;

drop policy if exists pres_select on ledger.presentations;
create policy pres_select on ledger.presentations for select to authenticated using (
  ledger.pres_is_member(company_id) and (
    owner_id = auth.uid()
    or visibility = 'company'
    or (visibility = 'shared' and ledger.pres_shared_with_me(id))
  )
);
drop policy if exists pres_insert on ledger.presentations;
create policy pres_insert on ledger.presentations for insert to authenticated with check (
  owner_id = auth.uid() and ledger.pres_is_member(company_id)
);
drop policy if exists pres_update on ledger.presentations;
create policy pres_update on ledger.presentations for update to authenticated
  using (owner_id = auth.uid() or ledger.pres_shared_with_me(id, true))
  with check (owner_id = auth.uid() or ledger.pres_shared_with_me(id, true));
drop policy if exists pres_delete on ledger.presentations;
create policy pres_delete on ledger.presentations for delete to authenticated using (owner_id = auth.uid());

drop policy if exists pres_sh_select on ledger.presentation_shares;
create policy pres_sh_select on ledger.presentation_shares for select to authenticated using (
  user_id = auth.uid() or ledger.pres_is_owner(presentation_id)
);
drop policy if exists pres_sh_write on ledger.presentation_shares;
create policy pres_sh_write on ledger.presentation_shares for all to authenticated
  using (ledger.pres_is_owner(presentation_id))
  with check (ledger.pres_is_owner(presentation_id));

-- Usuarios de la empresa (para elegir con quién compartir)
create or replace function ledger.pres_company_users(cid uuid)
returns table (user_id uuid, name text, email text)
language sql stable security definer set search_path = '' as $$
  select distinct u.id,
         coalesce(nullif(to_jsonb(u)->>'username', ''), nullif(to_jsonb(u)->>'full_name', ''), to_jsonb(u)->>'email', u.id::text),
         to_jsonb(u)->>'email'
  from accounts.user_companies uc
  join accounts.users u on u.id = uc.user_id
  where uc.company_id = cid
    and coalesce(uc.is_active, true)
    and ledger.pres_is_member(cid)
  order by 2;
$$;
revoke all on function ledger.pres_company_users(uuid) from public, anon;
grant execute on function ledger.pres_company_users(uuid) to authenticated, service_role;
grant execute on function ledger.pres_is_owner(uuid), ledger.pres_shared_with_me(uuid, boolean), ledger.pres_is_member(uuid) to authenticated;

select jsonb_build_object('presentations', to_regclass('ledger.presentations') is not null) as check_013;

commit;

notify pgrst, 'reload schema';
