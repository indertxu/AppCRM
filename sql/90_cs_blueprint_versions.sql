-- =====================================================================
-- 90_cs_blueprint_versions.sql — Versions of an e-mail blueprint
--
--   · cs_email_templates.variants  other versions of the same e-mail (own subject
--                                   and text), each for the clients it names:
--                                   [{ id, name, subject, body_html, html,
--                                      audience: { clients?, owners?, priorities?, health? } }]
--                                   A client gets the first version that applies to it,
--                                   everyone else the main one.
--   · cs_email_log.variant          which version went out
-- Safe to run more than once.
-- =====================================================================
begin;
alter table public.cs_email_templates add column if not exists variants jsonb not null default '[]'::jsonb;
alter table public.cs_email_log add column if not exists variant text;
notify pgrst, 'reload schema';
commit;
