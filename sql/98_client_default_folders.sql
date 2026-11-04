-- =====================================================================
-- 98_client_default_folders.sql — a new client gets the default folder template
-- =====================================================================
-- Settings › Clients › Folder templates: the template marked "Default" is
-- added to every new client's directory as soon as the client is created
-- (from a won deal, an import, the API…). Same rule as the "Templates"
-- button: only folders the client is missing are created; nothing is
-- renamed, moved or deleted. Safe to run more than once.
-- =====================================================================

create or replace function public.client_folders_from_tree(p_client uuid, p_tenant uuid, p_parent uuid, p_nodes jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  n jsonb; nm text; fid uuid; i int := 0; added int := 0;
begin
  if p_nodes is null or jsonb_typeof(p_nodes) <> 'array' then return 0; end if;
  for n in select * from jsonb_array_elements(p_nodes) loop
    nm := btrim(coalesce(n->>'name', ''));
    if nm = '' then continue; end if;
    select id into fid from client_folders
      where client_id = p_client and parent_id is not distinct from p_parent and lower(btrim(name)) = lower(nm)
      limit 1;
    if fid is null then
      insert into client_folders (client_id, tenant_id, parent_id, name, sort)
        values (p_client, p_tenant, p_parent, nm,
                (select count(*) from client_folders where client_id = p_client and parent_id is not distinct from p_parent))
        returning id into fid;
      added := added + 1;
    end if;
    added := added + client_folders_from_tree(p_client, p_tenant, fid, n->'children');
    i := i + 1;
  end loop;
  return added;
end $$;

create or replace function public.clients_add_default_folders()
returns trigger language plpgsql security definer set search_path = public as $$
declare t jsonb;
begin
  select tree into t from client_folder_templates
    where tenant_id is not distinct from new.tenant_id and is_default
    order by sort, created_at limit 1;
  if t is not null then
    perform client_folders_from_tree(new.id, new.tenant_id, null, t);
  end if;
  return new;
exception when others then
  -- never block creating a client because of its folders
  raise notice 'default folders not added to client %: %', new.id, sqlerrm;
  return new;
end $$;

drop trigger if exists clients_default_folders on public.clients;
create trigger clients_default_folders after insert on public.clients
  for each row execute function public.clients_add_default_folders();

revoke all on function public.client_folders_from_tree(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
