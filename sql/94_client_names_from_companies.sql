-- 94 · A client is called what its CRM company is called.
-- The company is the one source of the name: a client linked to a company takes
-- the company's name (when it is linked, and whenever the company is renamed).
-- Its legal name stays on its projects, untouched.

create or replace function public.client_name_from_company() returns trigger
language plpgsql set search_path = public as $$
declare n text;
begin
  if new.company_id is not null then
    select name into n from public.companies where id = new.company_id;
    if n is not null and btrim(n) <> '' then new.name := n; end if;
  end if;
  return new;
end $$;

drop trigger if exists client_name_from_company on public.clients;
create trigger client_name_from_company
  before insert or update of name, company_id on public.clients
  for each row execute function public.client_name_from_company();

create or replace function public.company_name_to_clients() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.name is distinct from old.name and btrim(coalesce(new.name, '')) <> '' then
    update public.clients set name = new.name where company_id = new.id and name is distinct from new.name;
  end if;
  return null;
end $$;

drop trigger if exists company_name_to_clients on public.companies;
create trigger company_name_to_clients
  after update of name on public.companies
  for each row execute function public.company_name_to_clients();

-- the clients already there
update public.clients c set name = co.name
  from public.companies co
 where co.id = c.company_id and c.name is distinct from co.name and btrim(coalesce(co.name, '')) <> '';
