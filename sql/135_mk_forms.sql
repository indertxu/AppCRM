-- 135_mk_forms.sql — Marketing › Forms
--
-- A form is a list of questions. Each question can be saved into a field of the
-- contact or the company (first name, e-mail, sector, a custom field…). Every form
-- gets a link (/f/<token>) that anyone can open and fill in — no sign-in. What they
-- send is kept as a response, and the contact / company is found (by e-mail, by
-- name or website) or created, and filled in.
--
--   mk_forms             the forms (fields + settings), one token each
--   mk_form_responses    what people sent
--   mk_form_public()     the form behind a token (anonymous: only live forms)
--   mk_form_submit()     sends a response (anonymous): saves it into the CRM
--
-- Safe to run twice.

create table if not exists public.mk_forms (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  name        text not null default 'Untitled form',
  token       text not null unique default replace(gen_random_uuid()::text, '-', ''),
  status      text not null default 'draft' check (status in ('draft', 'live', 'closed')),
  fields      jsonb not null default '[]'::jsonb,
  settings    jsonb not null default '{}'::jsonb,
  response_count integer not null default 0,
  last_response_at timestamptz,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists mk_forms_tenant on public.mk_forms (tenant_id);

create table if not exists public.mk_form_responses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  form_id     uuid not null references public.mk_forms (id) on delete cascade,
  answers     jsonb not null default '{}'::jsonb,
  contact_id  uuid references public.contacts (id) on delete set null,
  company_id  uuid references public.companies (id) on delete set null,
  email       text,
  source      text not null default 'link',
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists mk_form_responses_form on public.mk_form_responses (form_id, created_at desc);
create index if not exists mk_form_responses_tenant on public.mk_form_responses (tenant_id);

drop trigger if exists trg_set_tenant on public.mk_forms;
create trigger trg_set_tenant before insert on public.mk_forms for each row execute function public.set_tenant_id();
drop trigger if exists trg_set_tenant on public.mk_form_responses;
create trigger trg_set_tenant before insert on public.mk_form_responses for each row execute function public.set_tenant_id();

alter table public.mk_forms enable row level security;
alter table public.mk_form_responses enable row level security;
drop policy if exists tenant_isolation on public.mk_forms;
create policy tenant_isolation on public.mk_forms for all to authenticated
  using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()));
drop policy if exists tenant_isolation on public.mk_form_responses;
create policy tenant_isolation on public.mk_form_responses for all to authenticated
  using (tenant_id = (select current_tenant())) with check (tenant_id = (select current_tenant()));

-- ---------------------------------------------------------------------------
-- The form behind a link (anyone). Only live forms; a closed one says so.
-- ---------------------------------------------------------------------------
create or replace function public.mk_form_public(p_token text)
returns jsonb
language sql
security definer
set search_path to 'public'
stable
as $$
  select case
    when f.id is null then null
    when f.status = 'closed' then jsonb_build_object('closed', true, 'name', f.name, 'settings', f.settings - 'list_id' - 'mode' - 'notify')
    when f.status <> 'live' then null
    else jsonb_build_object('id', f.id, 'name', f.name, 'fields', f.fields,
                            'settings', f.settings - 'list_id' - 'mode' - 'notify',
                            'company', (select t.name from public.tenants t where t.id = f.tenant_id))
  end
  from (select 1) one
  left join public.mk_forms f on f.token = p_token;
$$;

-- ---------------------------------------------------------------------------
-- Send a response (anyone). Saves it, then finds / creates the contact and the
-- company and fills in the fields the questions point at:
--   field.map = 'contact.<column>' | 'contact.custom.<field id>'
--             | 'company.<column>' | 'company.custom.<field id>' | 'contact.opt_in' | null
--   settings.mode = 'fill' (only empty fields, default) | 'overwrite'
--   settings.create = false → only update people already in the CRM
--   settings.list_id → also add the contact to that (fixed) audience list
-- ---------------------------------------------------------------------------
create or replace function public.mk_form_submit(p_token text, p_answers jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  f public.mk_forms;
  fld jsonb;
  k text; v jsonb; sv text; m text;
  ct jsonb := '{}'::jsonb; ctc jsonb := '{}'::jsonb;
  co jsonb := '{}'::jsonb; coc jsonb := '{}'::jsonb;
  opt_in boolean := null;
  over boolean;
  may_create boolean;
  cid uuid; coid uuid; rid uuid;
  em text; host text;
  ct_cols text[] := array['first_name','last_name','email','phone','position','city','country','province','postal_code','street','linkedin','language','landline','notes'];
  co_cols text[] := array['name','legal_name','website','phone','email','city','country','province','postal_code','street','sector','vat_number','linkedin','landline'];
  missing text[] := '{}';
begin
  select * into f from public.mk_forms where token = p_token;
  if f.id is null or f.status <> 'live' then
    return jsonb_build_object('ok', false, 'error', 'This form is not open.');
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then p_answers := '{}'::jsonb; end if;
  over := coalesce(f.settings->>'mode', 'fill') = 'overwrite';
  may_create := coalesce((f.settings->>'create')::boolean, true);

  for fld in select * from jsonb_array_elements(f.fields) loop
    k := fld->>'id';
    if k is null or coalesce(fld->>'type', '') in ('heading', 'text_block', 'divider') then continue; end if;
    v := p_answers->k;
    sv := case when v is null or jsonb_typeof(v) = 'null' then null
               when jsonb_typeof(v) = 'array' then (select string_agg(x, ', ') from jsonb_array_elements_text(v) x)
               when jsonb_typeof(v) = 'string' then nullif(btrim(v #>> '{}'), '')
               else v #>> '{}' end;
    if coalesce((fld->>'required')::boolean, false) and sv is null and coalesce(fld->>'type', '') <> 'hidden' then
      missing := missing || coalesce(fld->>'label', k);
    end if;
    m := fld->>'map';
    if sv is null or m is null or m = '' then continue; end if;
    if m = 'contact.opt_in' then opt_in := sv in ('true', 'yes', '1', 'on');
    elsif m like 'contact.custom.%' then ctc := ctc || jsonb_build_object(substr(m, 16), v);
    elsif m like 'company.custom.%' then coc := coc || jsonb_build_object(substr(m, 16), v);
    elsif m like 'contact.%' and substr(m, 9) = any(ct_cols) then ct := ct || jsonb_build_object(substr(m, 9), left(sv, 4000));
    elsif m like 'company.%' and substr(m, 9) = any(co_cols) then co := co || jsonb_build_object(substr(m, 9), left(sv, 4000));
    end if;
  end loop;
  if array_length(missing, 1) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Please answer: ' || array_to_string(missing, ', '), 'missing', to_jsonb(missing));
  end if;

  -- the person: by the e-mail they typed, else by the one the link carried (then only filling blanks)
  em := lower(nullif(btrim(ct->>'email'), ''));
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'That e-mail address doesn''t look right.');
  end if;
  if em is null and nullif(btrim(p_meta->>'e'), '') is not null then
    em := lower(btrim(p_meta->>'e'));
    over := false;
  end if;
  if em is not null then
    select id into cid from public.contacts where tenant_id = f.tenant_id and lower(email) = em order by created_at limit 1;
  end if;

  if cid is not null then
    update public.contacts c set
      first_name  = case when ct ? 'first_name'  and (over or nullif(c.first_name, '') is null)  then ct->>'first_name'  else c.first_name end,
      last_name   = case when ct ? 'last_name'   and (over or nullif(c.last_name, '') is null)   then ct->>'last_name'   else c.last_name end,
      email       = case when ct ? 'email'       and (over or nullif(c.email, '') is null)       then ct->>'email'       else c.email end,
      phone       = case when ct ? 'phone'       and (over or nullif(c.phone, '') is null)       then ct->>'phone'       else c.phone end,
      position    = case when ct ? 'position'    and (over or nullif(c.position, '') is null)    then ct->>'position'    else c.position end,
      city        = case when ct ? 'city'        and (over or nullif(c.city, '') is null)        then ct->>'city'        else c.city end,
      country     = case when ct ? 'country'     and (over or nullif(c.country, '') is null)     then ct->>'country'     else c.country end,
      province    = case when ct ? 'province'    and (over or nullif(c.province, '') is null)    then ct->>'province'    else c.province end,
      postal_code = case when ct ? 'postal_code' and (over or nullif(c.postal_code, '') is null) then ct->>'postal_code' else c.postal_code end,
      street      = case when ct ? 'street'      and (over or nullif(c.street, '') is null)      then ct->>'street'      else c.street end,
      linkedin    = case when ct ? 'linkedin'    and (over or nullif(c.linkedin, '') is null)    then ct->>'linkedin'    else c.linkedin end,
      language    = case when ct ? 'language'    and (over or nullif(c.language, '') is null)    then ct->>'language'    else c.language end,
      landline    = case when ct ? 'landline'    and (over or nullif(c.landline, '') is null)    then ct->>'landline'    else c.landline end,
      notes       = case when ct ? 'notes' then concat_ws(E'\n\n', nullif(c.notes, ''), ct->>'notes') else c.notes end,
      custom      = case when over then coalesce(c.custom, '{}'::jsonb) || ctc else ctc || coalesce(c.custom, '{}'::jsonb) end,
      marketing_opt_out = case when opt_in is true then false else c.marketing_opt_out end
    where c.id = cid;
  elsif may_create and (em is not null or nullif(ct->>'first_name', '') is not null) then
    insert into public.contacts (tenant_id, first_name, last_name, email, phone, position, city, country, province, postal_code, street, linkedin, language, landline, notes, custom, marketing_opt_out)
    values (f.tenant_id,
            coalesce(nullif(ct->>'first_name', ''), initcap(split_part(split_part(em, '@', 1), '.', 1)), 'Form'),
            ct->>'last_name', coalesce(ct->>'email', em), ct->>'phone', ct->>'position', ct->>'city', ct->>'country', ct->>'province',
            ct->>'postal_code', ct->>'street', ct->>'linkedin', ct->>'language', ct->>'landline', ct->>'notes', ctc, coalesce(opt_in is false, false))
    returning id into cid;
  end if;

  -- the company: by name, else by website domain
  if nullif(btrim(co->>'name'), '') is not null or nullif(btrim(co->>'website'), '') is not null then
    if nullif(btrim(co->>'name'), '') is not null then
      select id into coid from public.companies where tenant_id = f.tenant_id and lower(btrim(name)) = lower(btrim(co->>'name')) order by created_at limit 1;
    end if;
    host := lower(regexp_replace(regexp_replace(coalesce(co->>'website', ''), '^https?://(www\.)?', ''), '/.*$', ''));
    if coid is null and host <> '' then
      select id into coid from public.companies where tenant_id = f.tenant_id and website ilike '%' || host || '%' order by created_at limit 1;
    end if;
    if coid is not null then
      update public.companies c set
        legal_name  = case when co ? 'legal_name'  and (over or nullif(c.legal_name, '') is null)  then co->>'legal_name'  else c.legal_name end,
        website     = case when co ? 'website'     and (over or nullif(c.website, '') is null)     then co->>'website'     else c.website end,
        phone       = case when co ? 'phone'       and (over or nullif(c.phone, '') is null)       then co->>'phone'       else c.phone end,
        email       = case when co ? 'email'       and (over or nullif(c.email, '') is null)       then co->>'email'       else c.email end,
        city        = case when co ? 'city'        and (over or nullif(c.city, '') is null)        then co->>'city'        else c.city end,
        country     = case when co ? 'country'     and (over or nullif(c.country, '') is null)     then co->>'country'     else c.country end,
        province    = case when co ? 'province'    and (over or nullif(c.province, '') is null)    then co->>'province'    else c.province end,
        postal_code = case when co ? 'postal_code' and (over or nullif(c.postal_code, '') is null) then co->>'postal_code' else c.postal_code end,
        street      = case when co ? 'street'      and (over or nullif(c.street, '') is null)      then co->>'street'      else c.street end,
        sector      = case when co ? 'sector'      and (over or nullif(c.sector, '') is null)      then co->>'sector'      else c.sector end,
        vat_number  = case when co ? 'vat_number'  and (over or nullif(c.vat_number, '') is null)  then co->>'vat_number'  else c.vat_number end,
        linkedin    = case when co ? 'linkedin'    and (over or nullif(c.linkedin, '') is null)    then co->>'linkedin'    else c.linkedin end,
        landline    = case when co ? 'landline'    and (over or nullif(c.landline, '') is null)    then co->>'landline'    else c.landline end,
        custom      = case when over then coalesce(c.custom, '{}'::jsonb) || coc else coc || coalesce(c.custom, '{}'::jsonb) end
      where c.id = coid;
    elsif may_create then
      insert into public.companies (tenant_id, name, legal_name, website, phone, email, city, country, province, postal_code, street, sector, vat_number, linkedin, landline, custom, source)
      values (f.tenant_id, coalesce(nullif(btrim(co->>'name'), ''), host), co->>'legal_name', co->>'website', co->>'phone', co->>'email', co->>'city', co->>'country',
              co->>'province', co->>'postal_code', co->>'street', co->>'sector', co->>'vat_number', co->>'linkedin', co->>'landline', coc, 'Form: ' || f.name)
      returning id into coid;
    end if;
    if cid is not null and coid is not null and not exists (select 1 from public.company_contacts where company_id = coid and contact_id = cid) then
      insert into public.company_contacts (tenant_id, company_id, contact_id) values (f.tenant_id, coid, cid);
    end if;
  end if;

  -- into an audience list
  if cid is not null and nullif(f.settings->>'list_id', '') is not null then
    begin
      insert into public.marketing_list_members (tenant_id, list_id, contact_id)
      select f.tenant_id, (f.settings->>'list_id')::uuid, cid
       where exists (select 1 from public.marketing_lists l where l.id = (f.settings->>'list_id')::uuid and l.tenant_id = f.tenant_id)
         and not exists (select 1 from public.marketing_list_members x where x.list_id = (f.settings->>'list_id')::uuid and x.contact_id = cid);
    exception when others then null;  -- a list that went away never loses the response
    end;
  end if;

  insert into public.mk_form_responses (tenant_id, form_id, answers, contact_id, company_id, email, source, meta)
  values (f.tenant_id, f.id, p_answers, cid, coid, em, coalesce(nullif(p_meta->>'source', ''), 'link'),
          coalesce(p_meta, '{}'::jsonb) - 'source')
  returning id into rid;
  update public.mk_forms set response_count = response_count + 1, last_response_at = now() where id = f.id;
  if cid is not null then
    begin perform public.crm_log(f.tenant_id, 'contact', cid, 'form', jsonb_build_object('form', f.name, 'response_id', rid)); exception when others then null; end;
  end if;

  return jsonb_build_object('ok', true, 'thanks', coalesce(nullif(f.settings->>'thanks', ''), 'Thank you — we got your answers.'),
                            'redirect', nullif(f.settings->>'redirect', ''));
end $$;

revoke all on function public.mk_form_public(text) from public;
revoke all on function public.mk_form_submit(text, jsonb, jsonb) from public;
grant execute on function public.mk_form_public(text) to anon, authenticated;
grant execute on function public.mk_form_submit(text, jsonb, jsonb) to anon, authenticated;
grant select, insert, update, delete on public.mk_forms, public.mk_form_responses to authenticated;
