-- =====================================================================
-- 120_my_outlook_connection.sql — Base · Settings › Integrations
-- =====================================================================
-- outlook_tokens has RLS and no policies (only edge functions read it), so the
-- page can't see when you connected Outlook. This returns, for the caller only,
-- the facts the Integrations detail shows — never the tokens.
-- Additive. Safe to run more than once.
-- =====================================================================
create or replace function public.my_outlook_connection()
returns table (account_email text, connected_at timestamptz, last_refresh timestamptz, scopes text)
language sql stable security definer set search_path = public as $$
  select t.account_email, t.connected_at, t.expires_at - interval '1 hour', t.scopes
  from public.outlook_tokens t where t.user_id = auth.uid();
$$;
revoke all on function public.my_outlook_connection() from public, anon;
grant execute on function public.my_outlook_connection() to authenticated;
