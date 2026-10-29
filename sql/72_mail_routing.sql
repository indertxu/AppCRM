-- =====================================================================
-- 72_mail_routing.sql — client mail and personal mail rules
-- =====================================================================
-- Needs 19_ticket_mail.sql.
--   ticket_mail_rules.scope    'desk' (the ticket desk, as before) or 'client'
--                              (Clients: mail that matches lands in that client's
--                              Emails, e.g. everything from @acme.es → Acme)
--   ticket_mail_rules.owner_id null = a rule for the whole company; a person =
--                              their own rule, run first on the mail of their own
--                              inbox (each person edits only theirs)
--   action 'file'              keep the e-mail in the client's Emails, no ticket
--   ticket_mail_messages.client_id / contact_id
--                              the client an e-mail belongs to and the contact who
--                              sent it (Clients › Emails filters by person)
--   status 'filed'             in a client's Emails, not waiting in the desk Inbox
-- Nothing is deleted. Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

do $$ begin
  if to_regclass('public.ticket_mail_rules') is null or to_regclass('public.ticket_mail_messages') is null then
    raise exception 'Run 19_ticket_mail.sql first.';
  end if;
end $$;

/* ---------- rules: client rules, personal rules, "file" ---------- */
alter table public.ticket_mail_rules add column if not exists scope text not null default 'desk';
alter table public.ticket_mail_rules add column if not exists owner_id uuid;
create index if not exists ticket_mail_rules_owner on public.ticket_mail_rules (tenant_id, owner_id, scope);

do $$ declare c record; begin
  for c in select conname from pg_constraint
            where conrelid = 'public.ticket_mail_rules'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) ilike '%action%' or pg_get_constraintdef(oid) ilike '%scope%') loop
    execute format('alter table public.ticket_mail_rules drop constraint %I', c.conname);
  end loop;
  alter table public.ticket_mail_rules add constraint ticket_mail_rules_action_check check (action in ('create', 'append', 'ignore', 'file'));
  alter table public.ticket_mail_rules add constraint ticket_mail_rules_scope_check check (scope in ('desk', 'client'));
end $$;

-- each person may write their own rules (the company's stay as they were)
drop policy if exists "mail rules: own" on public.ticket_mail_rules;
create policy "mail rules: own" on public.ticket_mail_rules for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and (tenant_id is null or tenant_id = public.current_tenant()));

/* ---------- messages: which client, which contact; "filed" ---------- */
alter table public.ticket_mail_messages add column if not exists client_id uuid;
alter table public.ticket_mail_messages add column if not exists contact_id uuid;
create index if not exists ticket_mail_messages_client on public.ticket_mail_messages (client_id, received_at desc) where client_id is not null;

do $$ declare c record; begin
  for c in select conname from pg_constraint
            where conrelid = 'public.ticket_mail_messages'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%status%' loop
    execute format('alter table public.ticket_mail_messages drop constraint %I', c.conname);
  end loop;
  alter table public.ticket_mail_messages add constraint ticket_mail_messages_status_check check (status in ('new', 'assigned', 'ignored', 'filed'));
end $$;

-- e-mails already on a client's tickets belong to that client
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'tracking_tasks' and column_name = 'client_id') then
    execute 'update public.ticket_mail_messages m set client_id = t.client_id
               from public.tracking_tasks t
              where m.client_id is null and m.ticket_id = t.id and t.client_id is not null';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

select (select count(*) from public.ticket_mail_rules where scope = 'client') as client_rules,
       (select count(*) from public.ticket_mail_rules where owner_id is not null) as personal_rules,
       (select count(*) from public.ticket_mail_messages where client_id is not null) as client_emails;
