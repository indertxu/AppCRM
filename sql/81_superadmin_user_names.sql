-- =====================================================================
-- 81_superadmin_user_names.sql — the superadmin sees each company's users by name
-- =====================================================================
-- Superadmin › a client company › Users only showed the e-mails: the names
-- live in each company's profiles, which the superadmin can't read across
-- companies. This function hands them over — only to a superadmin.
-- Nothing is changed or deleted. Safe to run more than once.
-- =====================================================================
begin;

create or replace function public.superadmin_user_names(p_tenant uuid)
returns table (id uuid, first_name text, last_name text, email text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin) then
    raise exception 'Only a superadmin can read this';
  end if;
  return query
    select p.id, p.first_name::text, p.last_name::text, coalesce(u.email, (to_jsonb(p) ->> 'email'))::text
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.tenant_id = p_tenant;
end $$;

revoke all on function public.superadmin_user_names(uuid) from public, anon;
grant execute on function public.superadmin_user_names(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

select 'superadmin_user_names ready' as status;
