-- 147_mk_form_actions.sql — Marketing › Forms: what an answer does in the CRM
--
-- mk_form_submit (135) learns settings.actions — each one optional, all safe to skip:
--   company      { on }                    false: leave companies alone (default true)
--   company_type { on, values: [labels] }  adds those types ("What it is to you") to the company
--   deal         { on, pipeline_id, phase_id?, owner_id?, name?, once? }
--                                          creates a deal in that pipeline (first phase by default),
--                                          linked to the person and the company, owner as given;
--                                          once (default true): not when they already have an
--                                          active deal in that pipeline. name: {company} {form} {name} {email}
--   task         { on, assignee_id, title?, due_days? }
--                                          a task on that person's To-do (due in N days), linked to the new deal
-- Contacts keep settings.create / settings.mode; the audience keeps settings.list_id.
-- The response's meta gets deal_id / task_id (and errors, if an action failed — the answer is never lost).
-- Safe to run twice.

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
  -- 147: what else an answer does (settings.actions)
  act jsonb;
  may_company boolean;
  pip uuid; ph uuid; own uuid; did uuid; tid uuid;
  nm text; coname text; dname text; ttl text;
  errs jsonb := '{}'::jsonb;
begin
  select * into f from public.mk_forms where token = p_token;
  if f.id is null or f.status <> 'live' then
    return jsonb_build_object('ok', false, 'error', 'This form is not open.');
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then p_answers := '{}'::jsonb; end if;
  over := coalesce(f.settings->>'mode', 'fill') = 'overwrite';
  may_create := coalesce((f.settings->>'create')::boolean, true);
  act := coalesce(f.settings->'actions', '{}'::jsonb);
  may_company := coalesce((act#>>'{company,on}')::boolean, true);

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
  if may_company and (nullif(btrim(co->>'name'), '') is not null or nullif(btrim(co->>'website'), '') is not null) then
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

  -- names for the deal / task titles
  if cid is not null then select nullif(btrim(concat_ws(' ', first_name, last_name)), '') into nm from public.contacts where id = cid; end if;
  nm := coalesce(nm, nullif(btrim(concat_ws(' ', ct->>'first_name', ct->>'last_name')), ''), em, 'Someone');
  if coid is not null then select name into coname from public.companies where id = coid; end if;

  -- mark the company (its types, "What it is to you")
  if coid is not null and coalesce((act#>>'{company_type,on}')::boolean, false) and jsonb_typeof(act#>'{company_type,values}') = 'array' then
    begin
      update public.companies c set relationship = (
        select array_agg(distinct x) from unnest(coalesce(c.relationship, '{}'::text[]) || array(select jsonb_array_elements_text(act#>'{company_type,values}'))) x
      ) where c.id = coid;
    exception when others then errs := errs || jsonb_build_object('company_type', sqlerrm);
    end;
  end if;

  -- a new deal (once per company / person and pipeline unless asked otherwise)
  if coalesce((act#>>'{deal,on}')::boolean, false) and (cid is not null or coid is not null) then
    begin
      pip := nullif(act#>>'{deal,pipeline_id}', '')::uuid;
      if pip is not null and exists (select 1 from public.pipelines p where p.id = pip and p.tenant_id = f.tenant_id)
         and not (coalesce((act#>>'{deal,once}')::boolean, true) and exists (
           select 1 from public.trackings t
            where t.tenant_id = f.tenant_id and t.pipeline_id = pip and coalesce(t.status, 'active') = 'active'
              and ((coid is not null and t.company_id = coid)
                   or (cid is not null and exists (select 1 from public.tracking_contacts tc where tc.tracking_id = t.id and tc.contact_id = cid))))) then
        ph := nullif(act#>>'{deal,phase_id}', '')::uuid;
        if ph is null or not exists (select 1 from public.pipeline_phases x where x.id = ph and x.pipeline_id = pip) then
          select x.id into ph from public.pipeline_phases x where x.pipeline_id = pip order by x.pos_x nulls last, x.pos_y nulls last, x.created_at limit 1;
        end if;
        dname := replace(replace(replace(replace(coalesce(nullif(btrim(act#>>'{deal,name}'), ''), '{company} — {form}'),
                 '{company}', coalesce(coname, nm)), '{form}', f.name), '{name}', nm), '{email}', coalesce(em, ''));
        dname := nullif(btrim(regexp_replace(dname, '^[\s—–-]+|[\s—–-]+$', '', 'g')), '');
        insert into public.trackings (tenant_id, company_id, pipeline_id, current_phase_id, status, deal_name, created_by)
        values (f.tenant_id, coid, pip, ph, 'active', left(dname, 200), f.created_by)
        returning id into did;
        if cid is not null then
          insert into public.tracking_contacts (tenant_id, tracking_id, contact_id) values (f.tenant_id, did, cid);
        end if;
        own := nullif(act#>>'{deal,owner_id}', '')::uuid;
        if own is not null then
          insert into public.tracking_employees (tenant_id, tracking_id, profile_id, is_owner) values (f.tenant_id, did, own, true);
        end if;
      end if;
    exception when others then did := null; errs := errs || jsonb_build_object('deal', sqlerrm);
    end;
  end if;

  -- a task for someone (on their To-do), linked to the new deal when there is one
  if coalesce((act#>>'{task,on}')::boolean, false) and nullif(act#>>'{task,assignee_id}', '') is not null then
    begin
      ttl := replace(replace(replace(replace(coalesce(nullif(btrim(act#>>'{task,title}'), ''), 'Follow up {name} ({form})'),
               '{company}', coalesce(coname, '')), '{form}', f.name), '{name}', nm), '{email}', coalesce(em, ''));
      insert into public.tracking_tasks (tenant_id, tracking_id, title, kind, priority, status, progress, due_at, assignee_id, created_by,
                                         category, source, stage, company_id, requester_contact_id, description)
      values (f.tenant_id, did, left(btrim(ttl), 300), 'quick', 'normal', 'todo', 0,
              now() + make_interval(days => greatest(0, least(60, coalesce((act#>>'{task,due_days}')::int, 1)))),
              (act#>>'{task,assignee_id}')::uuid, f.created_by, 'task', 'manual', 'new', coid, cid,
              'From the form “' || f.name || '”' || coalesce(' — ' || em, ''))
      returning id into tid;
    exception when others then tid := null; errs := errs || jsonb_build_object('task', sqlerrm);
    end;
  end if;

  insert into public.mk_form_responses (tenant_id, form_id, answers, contact_id, company_id, email, source, meta)
  values (f.tenant_id, f.id, p_answers, cid, coid, em, coalesce(nullif(p_meta->>'source', ''), 'link'),
          (coalesce(p_meta, '{}'::jsonb) - 'source' - 'deal_id' - 'task_id' - 'errors')
          || jsonb_strip_nulls(jsonb_build_object('deal_id', did, 'task_id', tid, 'errors', nullif(errs, '{}'::jsonb))))
  returning id into rid;
  update public.mk_forms set response_count = response_count + 1, last_response_at = now() where id = f.id;
  if cid is not null then
    begin perform public.crm_log(f.tenant_id, 'contact', cid, 'form', jsonb_build_object('form', f.name, 'response_id', rid)); exception when others then null; end;
  end if;

  return jsonb_build_object('ok', true, 'thanks', coalesce(nullif(f.settings->>'thanks', ''), 'Thank you — we got your answers.'),
                            'redirect', nullif(f.settings->>'redirect', ''));
end $$;

revoke all on function public.mk_form_submit(text, jsonb, jsonb) from public;
grant execute on function public.mk_form_submit(text, jsonb, jsonb) to anon, authenticated;

-- the public form never shows what the answers do (owners, pipelines…)
create or replace function public.mk_form_public(p_token text)
returns jsonb
language sql
security definer
set search_path to 'public'
stable
as $$
  select case
    when f.id is null then null
    when f.status = 'closed' then jsonb_build_object('closed', true, 'name', f.name, 'settings', f.settings - 'list_id' - 'mode' - 'notify' - 'actions' - 'create')
    when f.status <> 'live' then null
    else jsonb_build_object('id', f.id, 'name', f.name, 'fields', f.fields,
                            'settings', f.settings - 'list_id' - 'mode' - 'notify' - 'actions' - 'create',
                            'company', (select t.name from public.tenants t where t.id = f.tenant_id))
  end
  from (select 1) one
  left join public.mk_forms f on f.token = p_token;
$$;
revoke all on function public.mk_form_public(text) from public;
grant execute on function public.mk_form_public(text) to anon, authenticated;
