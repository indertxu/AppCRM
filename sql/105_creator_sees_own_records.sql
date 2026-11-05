-- 105: whoever adds a company or a contact can see it.
-- Companies and contacts are visible to bosses / sales managers / superadmins, and to everyone else only
-- when they're assigned (company_assignees / contact_assignees). Nobody was assigning the person who
-- created the record, so e.g. a marketing user added "Tilseco Energy Group" and its contact and then
-- couldn't find either of them. Now the creator (when they aren't someone who sees everything anyway)
-- is assigned automatically, and the records created so far are fixed from the CRM history.

create or replace function public.crm_is_lead(p_user uuid)
returns boolean language sql stable security definer
set search_path to 'public' as $$
  select coalesce((select coalesce(p.is_superadmin, false) or p.role in ('boss', 'sales_manager')
                     from public.profiles p where p.id = p_user), false);
$$;

create or replace function public.crm_assign_creator_trg()
returns trigger language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me uuid := auth.uid();
begin
  if me is null or public.crm_is_lead(me) then return null; end if;
  if tg_table_name = 'companies' then
    insert into public.company_assignees (tenant_id, company_id, profile_id)
    select n.tenant_id, n.id, me from newrows n
     where not exists (select 1 from public.company_assignees a where a.company_id = n.id and a.profile_id = me);
  else
    insert into public.contact_assignees (tenant_id, contact_id, profile_id)
    select n.tenant_id, n.id, me from newrows n
     where not exists (select 1 from public.contact_assignees a where a.contact_id = n.id and a.profile_id = me);
  end if;
  return null;
end $$;

drop trigger if exists crm105_co_creator on public.companies;
create trigger crm105_co_creator after insert on public.companies
  referencing new table as newrows for each statement execute function public.crm_assign_creator_trg();
drop trigger if exists crm105_ct_creator on public.contacts;
create trigger crm105_ct_creator after insert on public.contacts
  referencing new table as newrows for each statement execute function public.crm_assign_creator_trg();

-- the ones created so far (by someone who doesn't see everything) and still not visible to their creator
insert into public.company_assignees (tenant_id, company_id, profile_id)
select distinct c.tenant_id, c.id, h.actor
  from public.crm_history h join public.companies c on c.id = h.entity_id
 where h.entity = 'company' and h.action in ('created', 'imported') and h.actor is not null
   and not public.crm_is_lead(h.actor)
   and exists (select 1 from public.profiles p where p.id = h.actor and p.tenant_id = c.tenant_id)
   and not exists (select 1 from public.company_assignees a where a.company_id = c.id and a.profile_id = h.actor);

insert into public.contact_assignees (tenant_id, contact_id, profile_id)
select distinct c.tenant_id, c.id, h.actor
  from public.crm_history h join public.contacts c on c.id = h.entity_id
 where h.entity = 'contact' and h.action in ('created', 'imported') and h.actor is not null
   and not public.crm_is_lead(h.actor)
   and exists (select 1 from public.profiles p where p.id = h.actor and p.tenant_id = c.tenant_id)
   and not exists (select 1 from public.contact_assignees a where a.contact_id = c.id and a.profile_id = h.actor);
