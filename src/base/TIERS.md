# TIERS.md — Enterprise ⇄ Base: the shared log of both chats

> **Read this whole file at the start of every session, before touching anything.**
> **Add an entry to the [Change log](#9-change-log) after every change you make** (code, SQL, edge function, data).
> Two Claude chats work on this repo at the same time. This file is how they stay in sync.

| Chat | Owns | Works in |
|---|---|---|
| **Enterprise chat** | the full app + the shared kernel + the router + the superadmin console | `src/components/**`, `src/App.tsx`, `src/main.tsx`, `src/index.css`, `supabase/functions/**`, `sql/**` |
| **Base chat** | the simple app | `src/base/**` only (this folder; base SQL goes in `src/base/sql/`) |

Both chats share **one Supabase database**, **one sign-in**, **one repo**, **one deploy** (Vercel builds `main`).

---

## 1. The product (what the app does)

**Next** (repo `Facturacion-Consultoria`, React 19 + Vite + TypeScript + Supabase, deployed on Vercel) is a multi-tenant
operating system for consulting / software companies: CRM + sales pipeline + delivery + billing + customer success.
Each customer company is a **tenant** (`tenants` table); every row of every business table carries `tenant_id`
and Row Level Security keeps tenants apart (`current_tenant()` / `crm_my_tenant()` = the signed-in user's `profiles.tenant_id`).
UI text is **English**. Numbers are formatted `1.234.567,5` everywhere (main.tsx patches `toLocaleString`).

### Enterprise app pages (`src/components/pages/…`)
- **Home** (`homepage/`) — greeting hero with KPIs, a 5-day/month calendar widget (`HomeCalendar`), the tasks & tickets desk widget (`HomeTodo`), and role-specific widgets (consultancy / sales / management homes). Global search palette (`GlobalSearch`, ⌘K).
- **Tickets** (`/tickets`, `HomeTodo` → `TicketsPage`) — team ticket desk + personal tasks (tickets come from mailboxes too: `ticket_*` tables).
- **Calendar** (`calendar/`) — time logging (planned/confirmed/cancelled entries against clients/projects/work types, billable days), meetings, Outlook sync (edge fn `outlook-sync`), invites, time off, billing periods. Sales roles get `SalesCalendar` (meetings on deals) instead.
- **Contacts** (`contacts/`) — people; custom fields, import (spreadsheets), export, LinkedIn capture extension window (`/linkedin`), marketing lists (`MarketingPage`).
- **Companies** (`companies/`) — accounts; types (`crm_options` kind `relationship`, partner types), sectors, sources, custom fields, assignees, merge, import. Facts tables `company_facts` / `contact_facts` are pre-computed by triggers for fast server-side lists.
- **Clients** (`clients/`) — signed customers: directory, workspace (contracts, products, files/folders with templates, notes, health, CS owners), new client form, **Customer success** page.
- **Projects** (`projects/`) — delivery projects, backlog.
- **Deals / Sales** (`sales/`) — pipelines & phases, deal detail (`TrackingDetail`), products & calculators, proposals (AI templates, `proposal-ai`), handoff to client (contract, services), forecast, roles & access, import, **Reports** (`SalesReport`, report engine with periods/parameters).
- **Management** (`management/`) — team, backlog, billing & invoices, bonus plans, incoming, department document repositories.
- **Marketing**, **Customer success**, **Reports** — as above.
- **Settings** (`settings/`) — account, interface (dock order/labels), organization (departments, security levels, page access), users, catalog (products, services, tiers), pipelines, proposal templates, task settings, client folder templates.
- **Superadmin console** (`superadmin/`, `/superadmin`) — platform owner only (`profiles.is_superadmin`): companies (tenants), seats, users, usage, costs, **the company's plan (Enterprise/Base)**.

### Base app (`src/base/…`) — the simple tier
Pages: **Home**, **Tasks** (`/tickets`), **Calendar**, **Orbit** (`/orbit` — contacts, companies and clients in one page, see below), **Deals** (`/sales`), **Billing** (`/billing`), **Settings**.
No Projects, Management, Customer success, Marketing, Reports. Same data, same tables, simpler screens and processes.
It started (2026-11-04) as an exact copy of the Enterprise pages it needs (plus everything they import), so it works on day one;
the Base chat simplifies it from there: remove features, remove imports of things Base doesn't have, etc.
- **Billing** (`src/base/pages/billing/`, dock "Billing", page access key `management`): **Invoices** (write / send / follow up — draft, unpaid, overdue, paid, void; print/PDF + e-mail), **To bill** (client work and shipments logged in the Calendar and not on an invoice yet, per client → "Create invoice"), **Time** (hours per person and per client in a month; only your own without Management › Billing "Everyone"). Base invoices = `invoices` with `project_id` null + `client_id` + `invoice_lines` (sql 103).
- **Billing › Automatic invoices** (`AutoInvoiceModal.tsx`, button in the header): on/off, cutoff = last day of the month or a set day, made as drafts or sent; the day after each cutoff one invoice per client for everything up to it (pg_cron + a catch-up when Billing opens). "Bill now" up to any day.
- **Calendar (Base)**: no roles/targets in the bar — hours on clients per person on screen + "Nd to cutoff" (when automatic invoices are on). A new entry first asks *Client work* (hours on a client) · *Shipment* (product × quantity × price, can make the draft invoice at once) · *Something else* (title + time, kind `internal`, not billed; "Open the full booking" for invites / repeats). `WorkModal.tsx`; kinds `client_work` / `shipment`; billed entries are read-only and can't be dragged. Only clients whose **Team** (`clients.team`, new card in the client workspace: `ClientTeam.tsx`) includes you, or with no team; Management sees all.
- **Settings › Products & Services** = `BaseCatalog` (one page: products — name, kind, billing, price or tiers — and services — steps, how it bills, price, in a one-page pop-up; no blueprints tab/discounts/calculator).
- **Orbit** (`src/base/pages/orbit/`, dock label "Orbit", page access key `contacts`) replaces Contacts + Companies + Clients. The title is an icon switch **All · Contacts · Companies · Clients** (names open on hover; Clients only with access to the Clients page)
  (`/orbit`, `/orbit?view=contacts`, `/orbit?view=companies`). *All* = one A–Z list of both (`OrbitAll`: reads `contacts_list` + `companies_list` a block at a time
  and merges them by name; search; kind chip per row; a row opens its usual panel). *Contacts* / *Companies* = the full lists (filters, views, bulk, export…).
  **New** always opens one panel with a **Contact | Company** switch in its header (`KindSwitch`); switching keeps e-mail, phone, address and notes.
  How: `OrbitPage` mounts a second copy of `ContactsPage` / `CompaniesPage` with `only={…}` that renders just the editor; the lists take `orbit={…}` (New goes to Orbit, `refresh` re-reads after a save).
  `/contacts`, `/companies`, `/people` (and `?new=1`, and the focus state of a link) redirect to Orbit.

---

## 2. How the two apps are wired

```
main.tsx ─ AuthProvider (kernel) ─ AppRoutes (kernel router)
   /login, /reset-password ............ LoginPage (kernel)
   /linkedin .......................... Enterprise LinkedInCapture (lazy)
   /superadmin/** ..................... Enterprise superadmin console (lazy)
   /*  (signed in, not superadmin) .... TierApp:
         useAuth().plan === "base"  →  src/base/BaseApp.tsx          (lazy chunk)
         otherwise                  →  src/components/routes/EnterpriseRoutes.tsx (lazy chunk)
```
- **Plan** = `tenants.plan` (`'enterprise' | 'base'`, default `'enterprise'`). Read after sign-in with RPC `my_plan()` in
  `AuthProvider`, exposed as `useAuth().plan`. `roleLoading` stays true until role **and** plan are known.
- The superadmin sets it: console → company page → **Enterprise | Base** switch, or **New company → App**. RPC `sa_set_plan(p_tenant, p_plan)` (superadmin only).
  A company's people get the other app on their next page load. Nothing is deleted when switching.
- Each app is its **own lazy chunk with its own CSS**: a Base user never downloads Enterprise code/styles and vice versa.
  So class names may be the same in both copies without clashing — but **only because they never load together**. Don't import across apps.
- Links inside Base that point at Enterprise-only pages land on `/home` (`BaseApp` catch-all). `/contacts`, `/companies` and `/people` redirect to `/orbit` (search and state kept).

### The shared kernel (both apps import it; **Enterprise chat owns it**, Base imports read-only)
| File | What Base may use |
|---|---|
| `src/components/api/supabase.ts` | `supabase` (the one client — never create another), `usageMeter`, `netFailures`, `rememberReturnTo`, `takeReturnTo`, `setRememberMe`, `RETURN_TO_KEY` |
| `src/components/api/authContext.ts` | `useAuth()` → `{ session, role, isSuperadmin, plan, loading, roleLoading }`, types `Role`, `Plan` |
| `src/components/api/AuthProvider.tsx` | re-exports `useAuth` (older imports) |
| `src/components/login/LoginPage.tsx` | `passwordProblem`, `PASSWORD_HINT`, `PASSWORD_RULES`, `JUST_SIGNED_IN_KEY`, `DEACTIVATED_*` |
| `src/components/framework/PageCube.tsx` (+ `.css`) | `PageCube`, `PageLoader`, `PageCover`, `PC_LAND_T`, `pcPoseAt`, `pcAdopt` (the cube carries on from sign-in into Home on one shared clock) |
| `src/components/routes/AppRoutes.tsx` | — (the router; Base never edits it) |

Base imports the kernel by relative path from `src/base/...` (e.g. `../../../components/api/supabase`).
**Base must not import anything else from `src/components/`.** If Base needs something only Enterprise has, copy it into `src/base/`.
Enterprise must not import anything from `src/base/` (only `AppRoutes` lazy-loads `BaseApp`).

Kernel changes: the Enterprise chat makes them, keeps them backwards compatible, and logs them here with **KERNEL** in the entry.
The Base chat asks for kernel changes in [§8 Requests](#8-requests-between-the-chats).

---

## 3. Shared database — rules for both chats
One Supabase project: **`eloadnqjcrvdnvdcoqap`**. Every table is used by both apps (Base companies' data lives in the same tables).
1. **Never drop/rename a column, table, function, trigger or policy the other app uses.** Add, don't break. If something must change shape, log a request first.
2. **Migration numbers are global.** Claim the next number in [§7](#7-sql-numbering) *before* writing the file. Enterprise files: `sql/NNN_name.sql`. Base files: `src/base/sql/NNN_name.sql`.
3. Test changes with a `DO` block that ends in `raise exception` (rolls back) before applying. Apply with Supabase `apply_migration`.
4. Every new table: `tenant_id uuid default current_tenant()` (or `crm_my_tenant()`), RLS on, tenant policy.
5. Heavy triggers hurt both apps (example: 99 — adding a list option used to refresh the facts of every contact/company, ~20 s, and timed out). Keep triggers targeted.
6. **Never apply `30_orphan_company_types.sql`.**
7. Base may simply not use a feature's tables; it must not delete Enterprise data. A company can be switched back to Enterprise at any time and must find all its data intact.

Key tables: `tenants`(plan) · `profiles`(tenant_id, role, department, is_superadmin, prefs) · `companies`, `contacts`, `company_contacts`, `company_facts`, `contact_facts`, `crm_options`, `company_fields`, `contact_fields`, `*_assignees` · `clients`, `client_*` · `projects` · `trackings` (deals) + `tracking_*`, `pipelines`, `pipeline_phases` · `calendar_entries`, `entry_actuals`, `entry_invites`, `work_types`, `holidays`, `billing_periods` · `tickets` live in `tracking_tasks`/`ticket_*` · `invoices` · `page_access*`, `security_levels`, `org_departments` · `platform_*` (superadmin metering).

## 4. Edge functions (shared, Enterprise chat owns the code)
`manage-tenants` (superadmin: tenants/users/costs), `manage-users` (in-app user admin), `outlook-sync` (calendar & mail), `act-as` (superadmin impersonation, logged), `proposal-ai`.
Source in `supabase/functions/**`. Both apps call them; changes must stay backwards compatible. Base asks for new actions in §8.

---

## 5. Workflow (both chats)
- The user's Mac repo: `~/Desktop/Projects/Facturacion-Consultoria` (reached through the linked-computer tools).
- **Never commit or push.** Give the user the command, e.g.
  `cd ~/Desktop/Projects/Facturacion-Consultoria && git add -A && git commit -m "..." && git push origin main`
- Before overwriting a file on the Mac, check its md5 against the version you started from, so the user's own edits (or the other chat's) are never lost. Never edit a file the other chat owns.
- Type-check: `tsc -b --noEmit` (the repo has a known baseline of pre-existing errors: 58 in `src/components`, the same 25 copied into `src/base` on day one — don't add new ones). Build: `vite build`.
- Verify UI at 1280 / 1440 / 1913 wide: no overflow, no clipping. The user is very demanding about UI quality.
- Reply to the user briefly, in Spanish. UI text in English.
- Don't enter passwords in browsers; don't ask the user to paste API keys.

## 6. Keeping the two apps in step
- When the **Enterprise chat** fixes a bug or improves something in a page/module that also exists in `src/base/`, it logs it with **PORT?** and the file(s), so the Base chat can decide to bring it over (Base copies diverge on purpose; porting is Base's call).
- When the **Base chat** builds something Enterprise could use, it logs it with **IDEA→ENT**.
- Anything touching shared data (new column, changed meaning of a value, new RPC) is logged with **DB**.
- Read the other side's entries since your last session before you start working.

## 7. SQL numbering
Next free number: **150**  ← update this line when you claim one (and say which file in the log).
| # | File | Chat | What |
|---|---|---|---|
| 98 | sql/98_client_default_folders.sql | Enterprise | client folder templates → new clients |
| 99 | sql/99_crm_options_fast_triggers.sql | Enterprise | list options no longer refresh every contact/company |
| 100 | sql/100_tenant_plan.sql | Enterprise | `tenants.plan`, `my_plan()`, `sa_set_plan()`, plan in `sa_dashboard` |
| 101 | sql/101_sa_user_role.sql | Enterprise | `sa_roles(tenant)`, `sa_set_role(user, level)`: the superadmin sets someone's role |
| 102 | src/base/sql/102_base_service_billing.sql | Base | `services.billing` (upfront / by_step / monthly / hourly / daily) + `services.price` — Base's simple services |
| 104 | src/base/sql/104_base_auto_invoices.sql | Base | `base_billing_settings`, `base_billing_runs`, `base_bill_up_to` / `base_bill_now` / `base_billing_tick`, pg_cron `base-auto-invoices` (04:20 UTC) — applied 2026-11-05 |
| 103 | src/base/sql/103_base_billing.sql | Base | `invoices` + client_id / company_id / notes / tax_rate / bill_to, status may be `draft`; `invoice_lines`; `calendar_entries` + invoice_id / product_id / quantity / unit_price |
| 105 | sql/105_creator_sees_own_records.sql | Enterprise | creator auto-assigned to the companies / contacts they add (+ backfill from crm_history) |
| 106 | sql/106_marketing_manager_sees_crm.sql | Enterprise | marketing_manager sees every company / contact (companies_list, contacts_list, global_search, crm_is_lead) |
| 107 | sql/107_crm_scope_from_settings.sql | Enterprise | `crm_scope_ids(page)`: Companies / Contacts lists + search follow Settings › Security (page_data_scopes) |
| 108 | sql/108_cs_campaigns.sql | Enterprise | `cs_sequences.kind / from_address / launched_at / launched_by`: one-time CS campaigns, team mailbox |
| 109 | sql/109_mk_templates.sql | Enterprise | `mk_templates`: Marketing e-mail templates |
| 110 | src/base/sql/110_base_invoice_source_seller.sql | Base | `invoices.source` manual/auto; `base_billing_settings.seller_*` (issuer for invoices + Facturae XML); `base_bill_up_to` marks its invoices auto — applied 2026-11-05 |
| 111 | sql/111_crm_import_api.sql | Enterprise | `client_api_keys.scope` (files / crm) + `settings`, access `form`: companies & contacts import API keys (Settings › APIs) — applied 2026-11-06 |
| 112 | sql/112_company_fields_light_refresh.sql | Enterprise | `cf_trg_tenant_wide`: a company field's new choices / new field no longer rebuild every contact (only rename / retype / delete) — applied 2026-11-06 |
| 113 | sql/113_account_manager.sql | Enterprise | `company_assignees.is_manager` (one per company): account manager = starred person of Visibility; `companies_fx`/`companies_view_sql` key `account_manager`, `company_row_json.__manager`; old "Account Manager" custom field migrated to the star and removed — applied 2026-11-06 |
| 114 | sql/114_cs_flows.sql | Enterprise | CS sequences as trees (`cs_sequences.flow`), runs `node/wait_until/last_log_id`, `cs_email_log` opened/clicked/replied/links/node/from_address, `cs_run_events`, `cs_mailbox_sync`, `cs_track()`, `cs_mark_replies()`; hourly `cs_send_due()` → **cs-engine** — applied 2026-11-06 |
| 115 | sql/115_invite_bill_mode.sql | Enterprise | `entry_invites.bill_mode` fixed/they (who decides what an invitee bills); `alert_invite()` gives new series dates the figure the invitee chose; `calendar_entries.outlook_hide` (details left out of the Outlook event) — applied 2026-11-06 |
| 116 | sql/116_mail_known_only.sql | Enterprise | GDPR: `mail_is_known(tenant, email)` / `mail_row_known(...)` (contact, colleague, company e-mail, client contact list, or a company's own website / e-mail domain, or a company-linked contact's domain — never public domains); triggers drop unknown mail on insert (`ticket_mail_messages`) and e-mail tickets from unknown requesters (`tracking_tasks`); restrictive SELECT policy `mail_known_only` hides stored mail whose people left the CRM — applied 2026-11-07 |
| 117 | sql/117_purge_unknown_mail.sql | Enterprise | deletes the e-mail stored before 116 from people not in the CRM (64 rows on Konsolidator) — to run in the SQL editor |
| 118 | sql/118_project_team_alerts.sql | Enterprise | `alert_project_team()` + trigger `trg118_project_team_alerts` (after insert / update of team on `projects`): each person on the team gets a `user_alerts` row — kind `project_new` (created, e.g. Incoming › Build project) or `project_added` (put on an existing team), ref_type `project`, title = client, body = service · kick-off — applied 2026-11-09 |
| 119 | src/base/sql/119_connected_accounts.sql | Base | `connected_accounts` (several Gmail / Google Calendar / Outlook accounts per person: provider, email, services mail/calendar, status; RLS own rows select/delete) + `connected_account_tokens` (RLS on, no policies: service role only) — applied 2026-11-09 |
| 120 | src/base/sql/120_my_outlook_connection.sql | Base | `my_outlook_connection()` (security definer, caller only): account_email, connected_at, last_refresh (expires_at − 1h), scopes of your outlook_tokens row — never the tokens — applied 2026-11-09 |
| 121 | sql/121_client_churn_end.sql | Enterprise | `client_products.ends_on` (a running product stops that day: a churn on a future date) + `client_products_status_chk` widened to active/expired/cancelled/renewed/paused/ended — applied 2026-11-10 |
| 122 | sql/122_upsell_in_contract.sql | Enterprise | `client_products.contract_tracking_id` (+ index): the contract an upsell / hand-added product was signed into — applied 2026-11-10 |
| 123 | src/base/sql/123_connected_meta.sql | Base | `connected_accounts.provider` + `meta`; `connected_assets` (pages / Instagram / ad accounts of a Meta login, RLS own select) + `connected_asset_tokens` (service role only) — applied 2026-11-10 |
| 124 | src/base/sql/124_connected_linkedin.sql | Base | `connected_accounts.provider` + `linkedin`; `connected_assets.kind` + `linkedin_org` — applied 2026-11-10 |
| 125 | src/base/sql/125_connected_mailrelay.sql | Base | `connected_accounts.provider` + `mailrelay` (API-key account); `connected_assets.kind` + `mailrelay_group` |
| 126 | sql/126_report_sharing.sql | Enterprise | `sales_reports.shared_with` + `editors` (uuid[]); select/update policies widened; guard trigger (only the owner changes owner/sharing); alert trigger `report_shared` / `report_owner` — to run in the SQL editor |
| 127 | src/base/sql/127_whatsapp.sql | Base | `connected_assets.kind` + `whatsapp_number`; `whatsapp_messages` (in / out per number, RLS same tenant) — WhatsApp Cloud API |
| 128 | sql/128_handoff_alerts.sql | Enterprise | `billing_settings.handoff_notify` jsonb ({all, pipelines}) + trigger `trg128_handoff_alert` on handoffs insert → `alert_push(…, 'handoff_new', …, 'handoff', id)` — applied 2026-11-11 |
| 129 | sql/129_expansion_pipelines.sql | Enterprise | `pipelines.expansion_kind` (upsell / cross_sell) + `client_upsells.motion`; triggers: deal in such a pipeline ↔ client upsell (shared id `client_upsells.deal_id`), deal leads status/name/value/owner; `expansion_backfill(pipeline)` — to run in the SQL editor (tested in a rolled-back transaction) |
| 130 | src/base/sql/130_connected_google_ads.sql | Base | `connected_assets.kind` + `gads_customer` (Google Ads accounts of a Google login, last-30-days spend / clicks / conversions in extra) |
| 131 | sql/131_contracts.sql | Enterprise | `contract_templates` (catalogue contract blueprints, config jsonb) + `tracking_contracts` (contracts on deals: data jsonb, total, first_year), tenant RLS — applied 2026-11-11 (migration name "130_contracts", before Base claimed 130) |
| 132 | sql/132_ticket_mail_manual.sql | Enterprise | `ticket_mail_known()` (116's trigger) takes the tenant the row will get (it ran before trg_set_tenant, so every ticket created from Tickets › Inbox was dropped) and keeps a ticket filed by hand (request header `x-ticket-by-hand: 1`) — applied 2026-11-12 |
| 133 | src/base/sql/133_connected_google_analytics.sql | Base | `connected_assets.kind` + `ga_property` (Google Analytics 4 properties of a Google login, last-28-days users / sessions / key events in extra) |
| 134 | sql/134_fast_deal_visibility.sql | Enterprise | `my_visible_tracking_ids()` (uuid[], security definer) + the `team_visibility` policies of trackings and every deal table (products, services, contacts, employees, files, phase events, notes, meetings, tasks, proposals) check `tracking_id = any((select my_visible_tracking_ids())::uuid[])` instead of `can_see_tracking()` per row — same rule, a sales rep's page of deals 1.9 s → 23 ms — applied 2026-11-13 |
| 135 | sql/135_mk_forms.sql | Enterprise | Marketing › Forms: `mk_forms` (fields/settings jsonb, token, status draft/live/closed, response_count) + `mk_form_responses` (answers jsonb, contact_id, company_id, source, meta), tenant RLS; `mk_form_public(token)` and `mk_form_submit(token, answers, meta)` (security definer, granted to anon): saves the answer, finds the contact by e-mail / creates it, finds the company by name or website / creates it, links them, fills mapped fields (fill-blanks or overwrite), optional add to a fixed list — applied 2026-11-13 |
| 136 | sql/136_contract_groups.sql | Enterprise | Clients › Contracts: `contract_groups` (client_id, main_key, member_key, unique per tenant+member) — contracts of one client grouped under a main one; keys `t:<deal id>` / `l:<client id>|none`; tenant RLS — applied 2026-11-14 |
| 137 | src/base/sql/137_tenant_billing.sql | Base | `tenant_billing_manager()`; `tenant_billing_entities` (a company's legal entities / tax IDs to be billed under, one default; boss / org superadmin read+write) + `tenant_subscription_invoices` (what Next billed the company for the CRM: users, price per user per month, discount, VAT, bill-to snapshot, status, PDF; boss reads, platform superadmins write) — applied 2026-11-14 |
| 138 | sql/138_tenant_billing_events.sql | Enterprise | `tenant_billing_events` (each change to SQL 137's two tables, client or Next side, by triggers) + `tenant_billing_seen` (per person per company) + `user_alerts` kind `billing_next` to the company's bosses when Next changes their billing; realtime — applied 2026-11-14 |
| 139 | sql/139_mail_clients_only.sql | Enterprise | `mail_view_rules()`, `mail_is_client()`, `mail_row_allowed()`, `mail_can_see()`; sync trigger / read policy / ticket-from-mail trigger use clients-only (or the CRM, setting `keep`); restrictive policy `mail_whose` (who reads whose mail, page_data_scopes `mail_view`) — applied 2026-11-15 |
| 140 | sql/140_mail_view_reports.sql | Enterprise | `mail_can_see()`: scope `reports` (own + everyone below them via profiles.manager_id) and picked people add to any scope — applied 2026-11-15 |
| 141 | sql/141_mail_boss_follows_lists.sql | Enterprise | `mail_can_see()`: a Boss with their own line in 'mail_view' `users[id]` follows it (Settings › Tickets › Whose mail lists); unmoved Bosses still read all — applied 2026-11-15 |
| 144 | sql/144_marketing_senders_autopublish.sql | Enterprise | `marketing_campaigns.sender_account`, `marketing_posts.auto_accounts`, `mk_social_due()` + cron `marketing-social-due` (LinkedIn auto-publish) — applied 2026-11-16 |
| 145 | sql/145_connected_smtp.sql | Enterprise | `connected_accounts.provider` + `smtp`, `connected_accounts.settings jsonb` (IONOS Mail / SMTP mailboxes) — applied 2026-11-16 |
| 146 | sql/146_marketing_post_mentions.sql | Enterprise | `marketing_posts.mentions jsonb`, `marketing_posts.link_preview jsonb` (LinkedIn @mentions + the link card) — applied 2026-11-16 |
| 147 | sql/147_mk_form_actions.sql | Enterprise | `mk_form_submit` learns `settings.actions` (company on/off, company types, a deal, a task); `mk_form_public` hides actions — applied 2026-11-17 |
| 148 | sql/148_deal_phase_filter.sql | Enterprise | `phase_cond_sql()` + `deal_phase_index()`; `companies_view_sql` / `contacts_view_sql` learn filters of type `phase` (entered a deal phase since / before / between …) — applied 2026-11-17 |
| 149 | sql/149_mk_workflows.sql | Enterprise | Marketing workflows: `mk_workflows` / `mk_workflow_runs` / `mk_workflow_events`; `marketing_sends.campaign_id` nullable + `workflow_id, wf_run, wf_node, links`; `mk_track()` accepts the send’s own links; `mk_workflows_due()` + cron `marketing-workflows` (every 5 min) — applied 2026-11-17 |
| 150 | src/base/sql/150_entry_google_events.sql | Base | `calendar_entries.google_event_ids jsonb` ({ connected account id: Google event id }) — entries copied to Google Calendar get updated / removed instead of duplicated — applied 2026-11-17 |
| 151 | src/base/sql/151_entry_invite_mail.sql | Base | `calendar_entries.invite_mail jsonb` ({ team, guests, emails[] }) — e-mail calendar invitations chosen in the step-by-step pop-up — applied 2026-11-17 |

## 8. Requests between the chats
Write requests here; the other chat answers in the log and ticks them.
- [x] **Base → Enterprise (2026-11-14): issue CRM invoices to companies (SuperAdmin).** DONE by Enterprise 2026-11-14 23:40 (console › a company › Billing; see §9). SQL 137 adds `tenant_subscription_invoices` (+ `tenant_billing_entities`, the legal entities / tax IDs a company is billed under). Base's Settings › Your account shows them to the company's boss. Please add to SuperAdmin › a tenant: list its billing entities and record / issue invoices into that table (number, dates, users, `price_per_user` per month, `discount_pct`, net, VAT, total, status, `bill_to_*` copied from the entity, PDF url). Only superadmins can write it (RLS).
- [ ] **Base → Enterprise (2026-11-14): include `src/base/**` in the i18n dictionary.** Base now has the Language picker (Settings › Interface, kernel `i18n.ts`). Texts that only exist in Base (Pipeline library and guide, Integrations panels, Organization steps, Interface page…) are not in `i18n/<lang>.json` yet, so they stay English. Please run the i18n script over `src/base` too (or tell Base how to run it).
- [x] **Base → Enterprise (2026-11-12): two accounts in two tabs (KERNEL).** DONE by Enterprise 2026-11-12 11:15 (see §9); Base sign-outs switched 2026-11-14 (v73) — Base: switch your own Sign-out buttons (src/base/framework/Dock.tsx, SuperAdmin.tsx, pages/settings/SettingsPage.tsx) to `signOut({ scope: "local" })`. Today `smartStorage` in `src/components/api/supabase.ts` prefers localStorage, so with "Keep me signed in" all tabs share one session: signing in as someone else in tab 2, or signing out there, leaves tab 1 sending a closed session → "Not authenticated" / "Session not found" (seen 2026-11-12 09:50, inder@brazo.com ↔ indera@konsolidator.com). Ready-to-paste replacement in `src/base/requests/supabase-tab-sessions.ts.txt`: each tab keeps its own session; localStorage only seeds new tabs and is shared by tabs of the same user. Also the logout button → `supabase.auth.signOut({ scope: "local" })` (global closes that user's other tabs too). Base can't edit these files.
- [ ] **Base → Enterprise (2026-11-09): edge function `connected-accounts` — DEPLOYED by Base 2026-11-09 21:20 (v1); Enterprise: just adopt the source into `supabase/functions/connected-accounts/` when convenient.** The code is in `src/base/requests/connected-accounts.index.ts.txt` — copy it to `supabase/functions/connected-accounts/index.ts` and deploy it. Actions `connect` / `disconnect` / `check` / `token`; tables from SQL 119. It needs the secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (plus the existing `MS_CLIENT_ID`, `MS_CLIENT_SECRET`). The front end also reads `VITE_GOOGLE_CLIENT_ID`. Base's Settings › Integrations calls it to add Gmail, Google Calendar and extra Outlook accounts (the first Outlook stays in `outlook_tokens` / `outlook-sync`, untouched). Enterprise can use the same table / function for its own multi-account mail.

---

## 9. Change log
Newest first. Format: `### YYYY-MM-DD HH:MM · Chat · title` then bullets: files, what changed, tags (**KERNEL / DB / PORT? / IDEA→ENT**), deploy state.

### 2026-11-18 08:55 · Base · Company / contact pop-up forms: every field lines up
- `CrmModern.css` (v5 forms): every control in the pop-ups is 44px — phone fields were 46 (border on top of a 44 input), the contact's e-mail 42, "Link existing contact" / "New contact" 40. Labels stay on one line; a hint beside a label (`.dw-f-assist`) shortens with … instead of wrapping and pushing its field down (Language sat 15px lower than LinkedIn).
- E-mails: the field spans the full width like the others; Main / Make main / × (and the Remove? Yes / No ask) sit inside it on the right.
- Language hint shortened to "To group contacts by language" (full text on hover); the Sector hint got a hover title too.

### 2026-11-18 08:40 · Base · Company / contact pop-up header: two clean rows, nothing cut
- `CrmModern.css` (header v5): row 1 = logo, name, round quick links, close; row 2 (under a thin line) = the detail tiles, filling the row and wrapping only on narrow screens. Replaces v4's single row with `overflow: hidden`, where Website / E-mail shrank to nothing (icons on top of their labels) and Location got cut.
- `CompaniesPage.tsx`: new `DwQuick` (round link: website globe / LinkedIn "in", address on hover); Website and LinkedIn moved from tiles to quick links. `ContactsPage.tsx`: LinkedIn the same way.

### 2026-11-18 07:10 · Base · Calendar marketing mode uses the Calendar's own Week | Month switch and week picker
- `CalendarPage.tsx`: in marketing mode the normal `.cal-view-seg`, Today, arrows and `JumpPicker` stay and drive the marketing calendar (`mkNav = {view, anchor, dir, onWeek}` → `<MarketingPage calNav>`); the week label shows 7 days there. `.cv-mkbar` (New ▾) now sits right after the nav.
- `MarketingHub.tsx`: `MkCalNav` type, `HubCtx.calNav`; `CalendarTab` takes view/anchor from it when given (no own date/Today/Month-Week tools then; "See the week" calls `onWeek`). Grid and day row are keyed per view+period and glide in (`.mkc-in.is-next/prev`) instead of morphing.
- `CalendarModern.css`: "Up next / Not planned yet" stay with the to-do open (264px column); hidden only with the half-page to-do.

### 2026-11-18 06:55 · Base · Calendar with the to-do open: one clean layout, no scrollbars
- Marketing view inside the Calendar drops the hub's own margins (32px) and background, so it lines up with the work calendar and ends level with the to-do. The colour tokens (`--m-*`) are now also on `.cv-mkbar` (the bar is a portal outside `.mk`; Today was white on white).
- With the to-do open, the marketing side column (Up next / Not planned / AI) folds away; "Plan posts with AI" is now an item of New ▾ (`MkNewMenu`, `.mkn-ico.is-ai` in MarketingCalendar.css).
- Marketing week in the Calendar: light columns with hairlines (like the work week) instead of grey slabs; "Add a post" shows on hover and no longer leaves a gap above posts.
- To-do rows in the narrow column: title gets the full width, due + people go on a second line (scoped to `.cv-main:not(.is-wide) .cv-todo`).
- New `src/base/pages/calendar/ScrollHints.tsx`: no scrollbars anywhere on the Calendar; every list that scrolls gets `data-sh="up|down"` (edge fade via mask) and tall ones a floating "More ↓" pill that scrolls them on. Finds the scrollers itself (MutationObserver), so TicketDesk / MarketingHub need no changes.

### 2026-11-18 10:30 · Base · Calendar marketing mode: smooth switch, to-do stays, create from here
- `CalendarPage.tsx`: work and marketing calendars are stacked layers (`.cv-layers` › `.cv-layer.is-work` / `.is-mkl`, `inert` when hidden) that cross-fade and slide; the marketing view mounts on hover/focus of the megaphone or when the page is idle, then stays mounted, so there is no loader (fallback is a month-grid skeleton `MkCalSkel`). `.cv-mkbar` stays in the DOM while mounted; header controls fade back in after a switch (`is-flip`).
- Marketing mode now keeps the To-do button and panel; the "My time off" gear (`.cal-offbtn`) hides.
- `MarketingHub.tsx`: in `only="calendar"` mode, `openCampaign` opens the composer (`CampaignView`) in place of the calendar; back returns to it (no jump to Growth).
- `CalendarModern.css`: layer transitions, skeleton, New ▾ restored in the bar as a pine/lime pill (post, LinkedIn post, e-mail campaign).

### 2026-11-18 06:50 · Base · Calendar: a Marketing switch — the calendar of e-mail campaigns and social posts
- Files: src/base/pages/calendar/CalendarPage.tsx, CalendarModern.css, src/base/pages/growth/campaigns/MarketingHub.tsx.
- Calendar header: a megaphone button first among the icons (next to Outlook / Google, the bell, settings). On, the page shows the marketing calendar instead of your work week / month: it's Growth › Campaigns' own Calendar tab (month / week, the day pop-up, drag to move posts, "Up next", "Not planned yet"), lazy-loaded (`lazy(() => import(MarketingHub))`) so the Calendar doesn't pay for it until you switch. Its bar (‹ month / week ›, Today, Month | Week) takes the place of the work calendar's controls in the header (view switch, date nav, hours, people, sources, To-do hidden in `.cal.is-mk`); the subtitle reads "Marketing · e-mails and posts". Remembered per browser (`cal.mk`). Everyone sees it for now — who may see it (marketing / sales) comes later.
- `MarketingPage({ only: "calendar", barSlot })`: one tab, no tabs, no Actions menu, its bar portalled into `barSlot`. Opening an e-mail campaign from there goes to Growth › Campaigns › E-mail with it open (`sessionStorage` mk-open-camp, picked up on mount). "New ▾" and the "Write with AI" card are hidden in this view.
- No SQL. Deployed v140, committed locally; needs `git push`.

### 2026-11-18 00:20 · Base · Calendar pop-up: the last step redesigned (two clean cards), logos that fit, brand names never translated
- Files: src/base/pages/calendar/WorkModal.tsx, WorkModal.css ("v4 · the last step").
- Last step = 1) "what it is": Name + What you did as borderless fields in one card (label above, hairline between); 2) "options": one card of rows — label + short note left, control right, hairlines between: Billing (Billable / Not billable, amber when not), Calendars, Meeting (In person · Video · Phone), Call on (Teams / Google Meet, only for video with both calendars), To-do (switch, "due 16 Nov · 14:00"), Invoice (shipments). Every choice is the same pill switch (`seg`: track + sliding pine pill), on/off is one switch (`.wm-sw`). Replaces the billing cards, the grey "where it lives" box, the to-do bar and the summary. "Something else" shows the same options card at the bottom of Guests.
- Calendar chips: the logo in a 28px white circle (Next = /favicon.svg contained 19px; Outlook / Google Calendar = BRANDS glyph in its colour, 16px) — no more logos spilling out of the circle; Next always on (pine).
- `translate="no"` on Next / Outlook / Google / Teams / Meet (the Spanish translator turned "Next" into "Siguiente").
- Fits without scrolling (video + to-do on) in an 840px window. Deployed v139, committed locally; needs `git push`.

### 2026-11-18 00:00 · Base · Calendar pop-up: real logos, last step without scrolling; meetings cancelled in Outlook / Google are cancelled in Next
- Files: src/base/pages/calendar/WorkModal.tsx, WorkModal.css, CalendarPage.tsx, CalendarModern.css, src/base/api/calendarPush.ts.
- Logos: Next = /favicon.svg (the real logo); Outlook and Google Calendar = `BRANDS` (settings/brandIcons.ts, same as Integrations and My calendars); Teams / Meet badges in their colours.
- Last step fits without a scrollbar (checked down to a 780px-high window): billable / not billable as compact rows, "What you did" one line that grows, Calendars · Meeting · Call on as label rows, Teams / Meet as pills, the summary card removed — the time and the people moved into the header line.
- Deleting in Next (unchanged, checked): the Outlook / Google events go (Outlook's delete and Google's `sendUpdates=all` send the cancellation to guests); colleagues get "cancelled" (trigger `alert_entry_gone`) and their copies go (cascade).
- New, the other way: `entriesGoneOutside(ids)` + `cancelGoneEntries` — your own entries still ahead, not invoiced, with an event Next made: Google asked per event id (404 / 410 / cancelled), Outlook missing around its day and still missing ±45 days (an error or a full 1,500 page decides nothing). Those are cancelled in Next (their other copy removed with its cancellation, then the entry → colleagues told). The Calendar runs it on load, when the tab comes back and every 2 min, and shows a note ("A meeting was cancelled in your Outlook…").
- outlook-sync's own `check` (Deals meetings, kind=meeting) is untouched. No SQL. Deployed v138, committed locally; needs `git push`.

### 2026-11-17 23:20 · Base · Calendar pop-up: service as a dropdown, modern pickers, "Where it lives" (Next / Outlook / Google) + meeting type with Teams / Meet; entry marks
- Files: src/base/pages/calendar/WorkModal.tsx, WorkModal.css, CalendarPage.tsx, CalendarModern.css, src/base/api/calendarPush.ts, src/base/framework/DatePicker.css (v2 block), src/base/framework/TimePicker.tsx (popover size).
- Time step: the service is a pill dropdown next to the client (`PillMenu`); the 30 min / 1 h / 2 h / 4 h / 8 h chips are gone; Day / From / To are 46px pills.
- Date and time pickers (shared, every page): v2 look — light head, round days (pine + lime picked, lime ring today), round nav, pill buttons; the time picker in Inter (it fell back to a serif) with pine/lime rows and a pill Done; it now flips up when there's no room (size 264×384).
- Last step "Where it lives": Next (always) + Outlook / Google chips (connected ones; remembered per browser for new entries) → `invite_mail.sync`. Unticking one removes the entry's event from that calendar (`syncEntryEverywhere`). "Meeting": In person · Video call · Phone (`meeting_kind` in_person / teams / meet / phone); Video call with both calendars → pick Teams (from Outlook) or Google Meet (from Google), with one → that one. Teams: Outlook `online` (Teams link) and every invitation goes through Outlook; Meet: Google `conferenceData` (hangoutsMeet, `conferenceDataVersion=1`) and every invitation goes through Google — so everyone gets the same link. Invitation switches say where they go from and are off when the entry is only in Next.
- Calendar: an entry shows small O / G marks when it's also in your Outlook / Google (`googleIds` from `google_event_ids`); Next's own copies stay hidden from the overlay (by event id / same time, and `nextEntry` for Google). Video icon for `meet` too.
- No SQL (uses 150 / 151). Deployed v137, committed locally; needs `git push`.

### 2026-11-17 22:45 · Base · Calendar pop-up: Team + Guests steps; real Outlook / Google invitations (Gmail through Google) (SQL 151)
- Files: src/base/pages/calendar/WorkModal.tsx, WorkModal.css, src/base/api/calendarPush.ts, src/base/api/outlookSync.ts (`syncCalendarEntry(id, { attendees })` override), new src/base/sql/151_entry_invite_mail.sql (applied).
- People split in two steps — client work: What › Client › Time › **Team** › **Guests** › Billing; shipment: … › Product › Team › Guests › Send; something else: What › Details › Team › Guests.
  - Team: colleagues (entry_invites, accept / decline in Next as before) + "Also send it to their calendars" (on by default).
  - Guests: the client's company contacts suggested (`company_contacts` of `clients.company_id`), any contact by search, any e-mail typed by hand (Enter / "Add …"; kept in `invite_mail.emails`); "Send them a calendar invitation" (off by default — you choose whether the client gets one). Contacts stay in `attendees`.
  - Each switch says where it goes from: "Gmail addresses get it from your Google Calendar, everyone else from your Outlook" / only Outlook / only Google / "Connect Outlook or Google…" (disabled).
- Saved as `calendar_entries.invite_mail` { team, guests, emails }. `syncEntryEverywhere` works out the people (team: invitees not declined; guests: contacts' + typed e-mails; deduped, not you; only while the entry is still ahead) and routes them: Gmail / Googlemail → the first Google account shown (attendees, `sendUpdates=all`, so Google sends the invitation; the other Google accounts get a plain copy), everyone else → Outlook (outlook-sync attendees, Outlook sends it); with only one connected, all through it. Each person gets one invitation. Deleting the entry cancels it for them (Google `sendUpdates=all`, Outlook as before).
- Entries not made by the pop-up (invite_mail null) keep Outlook's old attendee rule.
- Deployed v136, committed locally; needs `git push`.

### 2026-11-17 22:15 · Base · Connecting Google / Microsoft / LinkedIn accounts works again (popup "closed" too early)
- Files: src/base/api/connectedAccounts.ts (`connectAccount`'s wait), same fix Enterprise made in `components/api/connectedAccounts.ts`.
- Google's sign-in page cuts the link to the opener (Cross-Origin-Opener-Policy), so `popup.closed` read true ~1 s after opening; Base gave up ("The sign-in window was closed") and nobody was listening when the code came back — the popup loaded /settings, handed the code over and closed, and no `connect` call ever reached the function (seen in the logs). Now "closed" only counts after this window has had the focus back for 2 s; the code still arrives by BroadcastChannel / storage; 10 minutes at most.
- Deployed v135, committed locally; needs `git push`.

### 2026-11-17 22:00 · Base · Calendar entries go to your Outlook and Google calendars (SQL 150)
- Files: new src/base/api/calendarPush.ts, src/base/api/googleCalendar.ts, src/base/pages/calendar/CalendarPage.tsx, WorkModal.tsx, new src/base/sql/150_entry_google_events.sql (applied).
- Every entry you log or edit (step-by-step pop-up, full booking, repeats, drag / resize — every place that called `syncCalendarEntry`) now goes through `syncEntryEverywhere`: Outlook exactly as before (`outlook-sync`), plus each Google account with Calendar on that My calendars shows — its primary calendar, Calendar API with the account's token (scope `calendar.events`, already granted; no reconnect). Event: "Client · Name" (or the kind), description = notes + kind / client / billable / who's invited + "Logged in Next"; shipments as free time; `extendedProperties.private.nextEntry` = entry id. Ids kept in `google_event_ids` → PATCH on edit (re-created if deleted in Google), DELETE when the entry is deleted (pop-up, full booking, series).
- New: the step-by-step pop-up (WorkModal) now also syncs to Outlook (it didn't) and removes its Outlook / Google events on delete.
- Not copied: entries logged from an Outlook / Google event (`outlook_source_id`), and other people's entries. Google events made by Next are not drawn again on the Calendar (`toEvent` skips `nextEntry`).
- Enterprise: nothing to do (column ignored); PORT? if Enterprise wants Google write-back — `calendarPush.ts` is self-contained.
- Deployed v134, committed locally; needs `git push`.

### 2026-11-17 16:50 · Base · Calendar pop-up: a name for every kind, a People step (invite colleagues / add contacts), "Add it to my to-do"; no more full booking link
- Files: src/base/pages/calendar/WorkModal.tsx, WorkModal.css, CalendarPage.tsx, invitesApi.ts.
- Name on all three kinds (Client work · Shipment · Something else): optional on client work / shipment (field on the last step), required on Something else. Saved as `name` (shipment falls back to "2 × Product") and `title` (= name or the auto label) — `title` is what the invite card and `alert_invite`'s notification show.
- New step **People** in every kind (client work: What › Client › Time › People › Billing; shipment: … › Product › People › Send; something else: What › Details › People): search colleagues (profiles, not inactive) and contacts (as you type, `contacts` ilike). Colleagues → `syncInvites` (entry_invites; the DB trigger notifies them; they accept / decline in the calendar bell and Home alerts, like Enterprise). Client work they bill like the organiser (same hours when billable), otherwise 0. Contacts → `calendar_entries.attendees` (CRM only, nobody is e-mailed). Reopening shows who's invited / accepted.
- **Add it to my to-do** (new entries, last step): a task (`createTicket`, category task, assigned to you, linked to the client) named like the entry, due on its day at its end time.
- Removed "Invite people or make it repeat? Open the full booking" (old BookingModal) and the `onOther` / `openBooking` / `logOutlookFull` paths. BookingModal still opens older non-work entries.
- invitesApi `entryFor`: an invitee accepting a **shipment** gets it as `internal` (billable 0, name = title) so it never reaches Billing. `toEntry`: an accepted invite shows the organiser's title as its name.
- No SQL (entry_invites, alert_invite, calendar_entries.title / attendees already exist). Deployed v133, committed locally; needs `git push`.

### 2026-11-17 16:35 · Base · Settings home fits the screen; each column scrolls on its own, no bar
- Files: src/base/pages/settings/SettingsPage.tsx (`StyScroll`; home root `sty is-home`), SettingsModern.css.
- The home is exactly the screen's height (no page scroll). Each column's cards scroll inside it with the bar hidden; the edges fade where there's more (top once you've scrolled, bottom while it goes on) and a white "More" pill with a bobbing chevron sits at the bottom — a click scrolls ~¾ of a column. The cards keep their hover lift (padding inside the scroller). Below 1100px the columns stack and the page scrolls as before.
- Deployed v132, committed locally; needs `git push`.

### 2026-11-17 16:25 · Enterprise · Marketing › Workflows: follow-ups that start after an e-mail campaign, a post or a form — SQL 149
- files: new `src/components/pages/contacts/workflows/MkWorkflows.tsx` + `.css` (list of workflows with live figures; editor: "Starts when" E-mail campaign (gets / opens / clicks / replies / doesn't open within N days) · Post (any or one, networks, fixed audience or team only) · Form (any or one), "also what happened before"; sender account; marketing owner; timeline of steps E-mail (Marketing template) / Wait & check (Replied · Opened, no reply · Didn't open) / Task (owner · contact's owners · creator · a person) / End, with day ranges, per-step figures and a log; Switch on / Pause / Run now), `contacts/ContactExport.tsx` ("Workflows" button next to the tabs on the Overview, with the count switched on; "Workflow" in the actions menu), `supabase/functions/marketing-hub/index.ts` (actions `wf_due` (cron key) and `wf_run` {id} (caller's JWT); engine: enrol, replies from `ticket_mail_messages`, tracked e-mails as `marketing_sends` rows, tasks in `tracking_tasks` with `external_ref mk-wf:…`), `sql/149_mk_workflows.sql`, i18n (+117)
- DB: new tables `mk_workflows`, `mk_workflow_runs` (unique workflow_id+source), `mk_workflow_events` (tenant trigger + tenant_isolation RLS); `marketing_sends.campaign_id` now nullable + `workflow_id, wf_run, wf_node, links` (code that groups sends by campaign_id sees workflow sends under a null key); `mk_track()` same as before + a click counts when the URL is one of the send's `links`; `mk_workflows_due()` + pg_cron `marketing-workflows` ('2-59/5 * * * *'). Tested in production with a throw-away workflow (no e-mails: wait & check → end, 6 runs) and deleted it.
- edge function: marketing-hub v8 deployed (old actions unchanged; the workflow sender must belong to the same company).
- tags: DB
- deploy: applied in Supabase / function deployed / written to the Mac / user to commit

### 2026-11-17 16:20 · Base · Settings home: the coloured cards back, in three columns; one-line head with a switch
- Files: src/base/pages/settings/SettingsPage.tsx, SettingsModern.css ("Home v4" replaces v3).
- Back to the coloured cards (gradient icon tile in each card's colour, soft glow, arrow circle, stats chips), stacked in three columns: Just you · Your company · Pages, each with its title, a count and one line.
- Head in one line like the other pages: a white pill with a pine gear circle + "Settings" and a sliding switch All · Just you · Your company · Pages (shows one column, its cards side by side; remembered per browser, `st-home-col`); the search pill on the right. Below 1100px the columns stack.
- Deployed v131, committed locally; needs `git push`.

### 2026-11-17 16:00 · Base · Settings home in three columns: Just you · Your company · Pages; Plan & billing split out of Your account
- Files: src/base/pages/settings/SettingsPage.tsx (new view `company`; home rendered as `.sty-cols` › `.sty-col` › `.sty-row`), SettingsModern.css ("Home v3"), AccountSettings.tsx (+ `part?: "you" | "company"`), AccountSettings.css (`.ya-grid.is-company`), src/base/pages/homepage/HomePage.tsx (billing alert → `settingsView: "company"`).
- Home: three equal columns, always in this order — Just you (Your account, Interface, Integrations) · Your company (Organization, Products & Services, Client Pipelines, Plan & billing) · Pages (Deals … Management). Each a white 26px card with a pine head (lime icon, count) and rows: icon circle, title, the full description, stats chips, arrow. The search filters the rows; empty columns say so. Below 1100px they stack.
- Your account is now only you (details, password, session). The company part (plan, billed as, history, Next's changes — Enterprise's billing mirror untouched) opens as Settings › Your company › Plan & billing (`<AccountSettings part="company">`), shown to role boss only, same rule as the page.
- Deep links: `settingsView: "company"` (new); Dock › Account still opens Your account.
- Deployed v130, committed locally; needs `git push`.

### 2026-11-17 10:20 · Enterprise · Filter "Entered a deal phase … since / before / between …" (Companies, Contacts, Clients, Deals, Marketing audiences) — SQL 148
- files: new `src/components/api/dealPhaseIndex.ts` (`deal_phase_index()` read once and cached 5 min → by deal / company / contact; `phaseHitMatches()`; `usePhaseOptions()`), `src/components/pages/companies/CompaniesPage.tsx` + `.css` (shared FilterBar: new FType `phase`, ops `p_since · p_before · p_between · p_last30 · p_last90 · p_year · p_ever · p_never`, phases checklist + dates, chip "SQL 2 since 1 Sept 2026"; Companies field `deal_phase`), `contacts/ContactsPage.tsx` (`deal_phase` = deals the contact is on), `clients/ClientsPage.tsx` (deals of the client's company; not offered as a column), `sales/sales/SalesPage.tsx` (`enteredPhase`), `contacts/exportCatalog.ts` (Kind `phase`, field "Deal · Entered phase", `p_never` counts as negative), `contacts/ContactExport.tsx` + `.css` (`PhaseCondVal` in export and audience conditions; `ExportExtra.phaseEntered`, and `phaseHistory` now from the whole index instead of one page of `tracking_phase_events`), i18n (+21), `sql/148_deal_phase_filter.sql`
- DB: `phase_cond_sql(kind, cond)` (EXISTS over `tracking_phase_events` joined to `trackings.company_id` / `tracking_contacts.contact_id`; day = UTC date of `entered_at`), `deal_phase_index()` (security invoker, compact JSON), `companies_view_sql` / `contacts_view_sql` re-created identical + a `type = 'phase'` branch (checked: same SQL as before for every other filter; "SQL 2 since 2026-01-01" = 47 companies / 56 contacts, as counted directly).
- tags: DB · PORT? (Base's FilterBar copy / growth audiences could offer it: the SQL side already answers `type: "phase"` conditions in companies_list / contacts_list)
- deploy: applied in Supabase / written to the Mac / user to commit

### 2026-11-17 09:50 · Enterprise · Marketing › Social: "Post as" you or a LinkedIn company page
- files: `src/components/api/marketingHub.ts` (`MyConnections.liPages?` = connected_assets `linkedin_org` of your LinkedIn sign-ins, type `LiPage`; optional field, NO_CONNECTIONS has `liPages: []`), `src/components/pages/contacts/ContactExport.tsx` (post editor: "Post as" chips — you / each company page / "Company page · Not set up yet" with an explanation; new posts default to the first page; preview shows the page's name), `MarketingOverview.css` (`.pe-as`), `src/components/pages/settings/integrations/Integrations.tsx` (LinkedIn: "Post as your company page" guide in place of the one-liner), `supabase/functions/marketing-hub/index.ts` (v7 deployed), i18n (+14)
- The choice is `marketing_posts.auto_accounts.linkedin_as` (the page's number; no SQL — auto_accounts is jsonb). marketing-hub posts with author `urn:li:organization:<n>` when the page is a `linkedin_org` asset of that person's LinkedIn sign-in; a 401/403 says to reconnect company pages.
- Today every LinkedIn sign-in only has `w_member_social` (no pages): posting as the company needs LinkedIn's Community Management API (second LinkedIn app → `LINKEDIN_PAGES_CLIENT_ID/_SECRET` secrets + `VITE_LINKEDIN_PAGES=1` / `VITE_LINKEDIN_PAGES_CLIENT_ID`). connected-accounts (Base's) already reads pages (`syncLinkedInOrgs`). Note for Base: its `whoIs` uses /v2/userinfo — the pages app needs "Sign In with LinkedIn using OpenID Connect" too.
- tags: PORT? (Base growth composer could offer the same "Post as" — reads `myConnections().liPages`) — edge function deployed
- deploy: marketing-hub v7 deployed / written to the Mac / user to commit

### 2026-11-17 08:40 · Enterprise · Calendar: Outlook / Google event card redrawn; it closes on any click outside
- files: `src/components/pages/calendar/CalendarPage.tsx` (`OutlookCard` → `.olc2`; outside-click and the status card listen in the capture phase), `src/components/pages/calendar/CalendarModern.css` (`.olc.olc2 …`), `src/components/api/outlookSync.ts` (`cleanPreview()`; `placeOf()` also drops "Reunión de Microsoft Teams" / "Microsoft Teams Meeting" / "Google Meet" / "Zoom"), i18n (+7)
- Bug: the card never closed when clicking the grid — the grid's `onMouseDown` stops propagation (drag to book) so the document listener never heard it. Now capture phase; a click on the grid only closes the card (no booking starts), another event's block opens its own card in one click, Esc closes.
- Card: source colour band on top; pills Outlook / Google · Repeats · Tentative; "Open in …" as an icon next to ×; big title; date with icon + time and duration ("2 h"); rows with icons (place, organiser, people, Google account); the description without Teams / Zoom / Meet boilerplate and links (3 lines); Join <Teams / Google Meet / Zoom> + "Log it as work" (or "Make it a meeting") side by side, Log full width when there is no call.
- tags: PORT? (Base: src/base/pages/calendar/CalendarPage.tsx OutlookCard has the same never-closes bug) — no SQL
- deploy: written to the Mac / user to commit

### 2026-11-17 08:25 · Enterprise · Calendar: join Google Meet / Teams / Zoom straight from the grid and the event card
- files: `src/components/api/outlookSync.ts` (`callLinkIn()` finds a Meet / Zoom / Teams / Webex / Whereby / Jitsi link in free text; `callName()`; `placeOf()`; Outlook events without `onlineMeeting` take the link from their place or preview), `src/components/api/googleCalendar.ts` (join = hangoutLink → video entry point → link in location / description), `src/components/pages/calendar/CalendarPage.tsx` (exported `JoinCall`, card's primary "Join Google Meet / Teams / Zoom" button), `SalesCalendar.tsx` (same on its blocks), `CalendarModern.css` (`.cal-ol-join`, `.olc-join`), i18n (+7)
- Every Outlook / Google block with a call link gets a round video button (top right) that opens the call without opening the card; from 10 min before until the end it is filled, pulses and says "Join" when the block is wide enough. Narrow blocks keep their title (button only while live). A place that is only a URL no longer shows as "Where".
- tags: PORT? (Base: src/base/pages/calendar/CalendarPage.tsx OutlookCard + week blocks, src/base/api/googleCalendar.ts toEvent) — no SQL
- deploy: written to the Mac / user to commit

### 2026-11-17 08:10 · Enterprise · Calendar: Google Calendar next to Outlook, exactly like Base (Other calendars + Settings › Calendar › My calendars)
- files: new `src/components/api/googleCalendar.ts` and `src/components/api/calendarSources.ts` (copies of Base's `src/base/api/googleCalendar.ts` / `calendarSources.ts`), new `src/components/pages/calendar/CalendarSources.tsx/.css` (copy of Base's, `.csrc-`), `src/components/api/outlookSync.ts` (`OutlookEvent.src?: "google"`, `account?`), `src/components/pages/calendar/CalendarPage.tsx` + `SalesCalendar.tsx` (Google events, `cal.google` switch, `GGlyph`/`SrcGlyph`/`srcName`), `src/components/pages/settings/SettingsPage.tsx` (Settings › Calendar gets "My calendars" first), `src/components/framework/i18n/{en,es,de,nl}.json` (+26)
- Every connected Google account with Calendar (Settings › Integrations) is read from the browser with its token (connected-accounts → `token`), primary calendar, 3-min cache; events drawn like Outlook's but red (#d93025) in week blocks, all-day tags, month chips and the event card ("Google Calendar · <account>", "Open in Google Calendar"); "Log it as work" / "Make it a meeting" work on them too (entry keeps `outlook_source_id = g:<id>`).
- Header "Other calendars": Outlook and Google rows, each with its switch, "N events in view" / Hidden / Couldn't load it + Retry; "Choose which calendars and accounts →" opens Settings › Calendar. My calendars (Google / Outlook / Both + a switch per account) is per person in `profiles.prefs.calendarSources` — same key as Base, so one choice serves both tiers.
- tags: PORT from Base (no SQL, no edge function change)
- deploy: written to the Mac / user to commit

### 2026-11-17 06:30 · Enterprise · Marketing › Forms: bar tools, cards or list, a modern builder, and what each answer does in the CRM (SQL 147)
- files: `src/components/pages/contacts/forms/MarketingForms.tsx` (FormsTab tools in the page bar, `FormRow` list view, `doesWhat` / `DoesChips`, new **Actions** tab = `FormActions`, old Settings tab folded into it), new `forms/FormsModern.css`, `forms/formsKit.tsx` (`FormSettings.actions`, `FormActionsCfg`), `src/components/pages/contacts/ContactExport.tsx` (FormsTab gets `bar`, `onCampaign`, `onListsChanged`; `pendingList` pre-picks the audience of a new campaign), new `sql/147_mk_form_actions.sql`, `src/components/framework/i18n/{en,es,de,nl}.json` (+57)
- List: All / Live / Draft / Closed, search, Cards | List (remembered, `mk-forms-view`) and "New form" sit right of the page's tabs. List view = white pill rows (form, status, questions, answers, last answer, what it does as icons, hover actions).
- Builder in the modern look (pill palette with icon circles, grey canvas, pill fields, pine question toolbar kept inside the canvas); the form's bar in pills, one line down to 1280.
- Actions tab ("When someone sends …"): the contact (create / keep or replace), the company (on/off, "Add a Company question"), mark the company as <types> (crm_options relationship), open a deal (pipeline, start phase, owner, name with {company} {name} {form} {email}, once per pipeline), a task for someone (assignee, due, title), add to an audience (or "New audience for this form" = fixed list with everyone who already answered), follow up by e-mail (opens a campaign with that audience), after sending; a live "Each answer will…" summary. Answers drawer: "Open the deal", "Task created", errors.
- DB: 147 replaces `mk_form_submit` (same as 135 + `settings.actions`: company.on, company_type, deal, task; ids / errors into the response's meta; an action that fails never loses the answer) and `mk_form_public` (no longer sends actions / create to the public page). Tested on live data in a rolled-back block (deal with contact + owner, task linked to the deal, type added, second answer skipped by "once").
- tags: DB · PORT? (Base's Growth › Campaigns forms, if they share MarketingForms)
- deploy: SQL 147 applied in Supabase 2026-11-17; files written to the Mac; user to commit

### 2026-11-17 05:50 · Base · Growth › Campaigns › Calendar = Enterprise's new Marketing calendar (PORT of 05:20 + 05:55)
- Files: src/base/pages/growth/campaigns/MarketingHub.tsx (`CalendarTab`, `MkNewMenu`, `MkcCard` taken from Enterprise `contacts/ContactExport.tsx` as of 05:55; `mkh-tools` bar on for calendar), new src/base/pages/growth/campaigns/MarketingCalendar.css (= Enterprise's), src/base/pages/growth/GrowthModern.css.
- Same as Enterprise: ‹ month / week › pill, Today (only away from now), Month | Week (remembered), channel filters + "N planned" in the card's top line; month with round day numbers, pill items, a day opens into a pop-up grown from the cell; week with a column a day and cards (picture, time, networks, title, state); side "Up next" + "Not planned yet"; drag and drop.
- Base-only: the "Write with AI" card stays on top of the side column; "New ▾" is hidden here (creating lives in Actions, top-right), like E-mail / Social.
- Growth bar switches (Campaigns | Templates, Month | Week) are now 44px round pills.
- Deployed v129, committed locally; needs `git push`.

### 2026-11-17 05:35 · Base · Growth: E-mail without KPIs; Campaigns tabs fold until you point at them
- Files: src/base/pages/growth/GrowthModern.css (CSS only).
- E-mail tab inside Growth hides the KPI row (`.gr-live .em-kpis`): just the campaigns / templates list.
- Campaigns' tabs (Dashboard · E-mail · Social · Calendar · Audiences · Forms) rest compact, with only the open tab's name. Pointing at the row expands every name and count; it stays open after a click while the pointer is there and folds when it leaves (keyboard focus also opens it). The sliding pill follows. Replaces the ≤1700px rule for these tabs; the Growth sections switch is unchanged.
- Deployed v128, committed locally; needs `git push`.

### 2026-11-17 05:30 · Base · Growth: "Write with AI" card in the right column (E-mail, Social, Calendar)
- Files: src/base/pages/growth/campaigns/MarketingHub.tsx (`MhAiCard` replaces `MhAiBar` and `MhAiSide`), src/base/pages/growth/GrowthModern.css (`.gac-*`, `.gai-split` grid; old `.gai`/`.gas` styles removed).
- The horizontal AI bar on top is gone everywhere. One light card sits at the top of the right column: pine/lime icon, E-mail | Posts switch with a sliding pill, a brief that grows as you type with a send button inside (⌘↵), idea chips per mode, and on E-mail three "how it works" steps.
- E-mail: list + right column of 300px (260px ≤1360px), the same width as Social's column. Social: the card goes above Channels (column scrolls if needed). Calendar: above "Not planned yet".
- Deployed v127, committed locally; needs `git push`.

### 2026-11-17 06:05 · Enterprise · Audiences opens at once; the list's header on one line
- files: `src/components/pages/contacts/ContactExport.tsx` (`ListsTab`, `ListEditor`), `AudiencesModern.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+5)
- Slow tab: opening Audiences evaluated every list over all contacts (58 lists × 30 000 contacts) before painting — ~1.2 s frozen in a test with that size. Now the side list shows the saved `member_count` at once and counts the lists after the panel is on screen, in ~12 ms slices, cached per engine (`LIST_SIZES`, so coming back is instant); the editor evaluates its conditions with `useDeferredValue` (count shows "…" / dims while it works, editing stays smooth). Same test: ~60 ms. Row entrance delays capped (58 rows no longer queue up).
- Header in one line: icon · name · what it's for (inline) · Dynamic / Fixed / New chip (the long text is its tooltip) · delete · export · "Save as fixed" · Save. Contacts / Companies moved into "Who's in" (the first group's header). The saved message floats under the header and fades after 5 s.
- deploy: written to the Mac; user to commit

### 2026-11-17 05:20 · Base · AI briefs grow as you type; Actions menu in Next's look
- Files: src/base/pages/growth/campaigns/MarketingHub.tsx (`AutoText`), src/base/pages/growth/GrowthModern.css, src/base/framework/ActionsMenu.css.
- `AutoText`: a textarea that grows with its text (no inner scroll); used for the E-mail AI panel, Plan posts with AI (brief and each generated post), and the AI briefs in the e-mail and post composers. The Dashboard's AI card keeps its fixed box.
- ActionsMenu (shared by every Base page): appended "Next look v2" — solid white 24px card, shorter rows, round icons (pine + lime for the main action, soft mint for the rest, lime for AI), one-line hints, quiet shortcuts, max-height with its own scroll. Button styles per page unchanged.
- Growth: the Actions circle gets lime dots, like Billing and Orbit.
- Deployed v126, committed locally; needs `git push`.

### 2026-11-17 12:00 · Base · Growth › E-mail: list 80% + AI side panel; demo data
- Files: src/base/pages/growth/campaigns/MarketingHub.tsx (`MhAiSide`, `.gai-split` wrapper on the E-mail tab), src/base/pages/growth/GrowthModern.css (`.gai-split`, `.gas-*`).
- E-mail tab: campaigns/templates list ~80%, a vertical AI panel on the right ~20% (260–340px): brief box, "Write the e-mail" (lime), "Plan posts instead", four starter ideas, a note that nothing is sent without review. The horizontal AI bar now shows only on Social and Calendar.
- Data only (no schema), tenant Brazo: 4 static audiences with members, 4 mk_templates, 5 marketing_campaigns (3 sent with marketing_sends, 1 scheduled, 1 draft).
- Deployed v125, committed locally; needs `git push`.

### 2026-11-17 05:55 · Enterprise · Marketing › Calendar: a day opens into a pop-up; new cards in the week
- files: `src/components/pages/contacts/ContactExport.tsx` (`CalendarTab`, new `MkcCard`), `MarketingCalendar.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+5)
- Month: a click on a day (outside its items) opens a pop-up that grows out of the cell (Web Animations from the cell's box): the day as a tile, "N planned", every post / e-mail as a card, "Add a post" and "See the week"; Escape / click outside closes; "+N more" opens it too. Cards in it can still be dragged to another day.
- Week: each day a soft rounded column (today light lime); each item a white card with a shadow — picture on top when the post has one (or its link preview's), network / e-mail icon + time (+ other networks), title (3 lines), a line of the text or "To <list>" for e-mails, state as a dot + word (ready now amber, scheduled blue, drafts violet, sent green); lime ring on hover; "Add a post" dashed on hover.
- deploy: written to the Mac; user to commit

### 2026-11-17 05:45 · Base · Growth in the Deals look; Campaigns tabs on the top row; a customisable Dashboard
- files: `src/base/pages/growth/GrowthPage.tsx` (no banner/title; `tabsSlot` / `actSlot` for Campaigns; an Actions menu top-right on the other sections — New campaign (preview), Campaigns), `src/base/pages/growth/GrowthModern.css` (rewritten header + full-screen Campaigns), `src/base/pages/growth/campaigns/MarketingHub.tsx` (`MarketingPage({ embedded, tabsSlot, actSlot })`: its tabs portal into Growth's top row, its Actions menu top-right; first tab "Dashboard" = the hub's customisable board)
- Top row like Deals / Orbit › Clients / Billing: white 44px pills on the grey canvas — Growth sections (Next-green pill), then on Campaigns its own tabs (Dashboard · E-mail · Social · Calendar · Audiences · Forms, pine pill that slides), and the pine Actions launcher top-right (New e-mail, Social post, Plan posts with AI, Import posts, Audience list, Form, Customize the dashboard). The tab-level "New e-mail" / "New post" / "Plan with AI" buttons are hidden here (they're in Actions).
- Campaigns fills the screen — the page never scrolls; lists, calendar and the board scroll inside. Dashboard: the e-mail + social cards (reach, delivered, open / click rate, social views, form answers, coming up, last campaigns, funnel, needs you, write with AI…), Add cards / move / resize / reset via Actions › Customize the dashboard.
- Below 1700px only the open tab keeps its name in both tracks.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-17 05:20 · Enterprise · Marketing › Calendar: date, Today, Month / Week and "New ▾" in the bar; modern month, week and side lists
- files: `src/components/pages/contacts/ContactExport.tsx` (`CalendarTab` rebuilt, new `MkNewMenu`), new `src/components/pages/contacts/MarketingCalendar.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+12)
- The bar right of the tabs: ‹ month / week › as one pill, "Today" (pine, only when you're away from the current month / week), Month | Week (remembered per browser, `mk-cal-view`), and a green "New ▾" (Social post · LinkedIn post · E-mail campaign; custom menu). Channel filters moved into the card's top line with the "N planned this month / week" count.
- Month: white 26px card, hairlines, round day numbers (today lime), pill items with a network dot, ready-now amber, drafts outlined, a green "+" on hover; "+N more" opens that week. Week: a column a day with each post / e-mail as a card (time, networks, title, status) and "Add a post". Drag and drop to move posts works in both.
- Side: new "Up next" (the next 8 planned posts and e-mails, date tiles tinted by network, ready-now flagged) + "Not planned yet" restyled.
- tags: PORT? (Base's Growth › Campaigns calendar, if it shares this tab)
- deploy: written to the Mac; user to commit

### 2026-11-17 05:10 · Base · Growth › Campaigns is live (e-mail, social, calendar, audiences, forms + AI, recurring posts)
- files: `src/base/pages/growth/GrowthPage.tsx` (Campaigns renders the live hub; "Overview" tab marked translate="no" so it never reads "Resumen"; Preview / brand / mock "New campaign" hidden on Campaigns; the mock `Campaigns` kept, exported, for reference), new `src/base/pages/growth/GrowthModern.css`, new `src/base/pages/growth/campaigns/` — `MarketingHub.tsx` (= Enterprise `contacts/ContactExport.tsx` of today, imports re-pointed to Base), `MarketingHub.css` (= ContactExport.css), `MarketingOverview.css`, `PostMentions.tsx`, `importBatches.ts`, `brandIcons.ts`, `kpiStrip.tsx` (= Enterprise DealKpis.tsx, uses Base's DealKpis.css), `forms/` (MarketingForms, formsKit, CSS)
- Shared with Enterprise (not copied): `components/api/{supabase,marketingHub,outlookSync}`, `components/framework/PageCube` (PageLoader). Same tables (marketing_*, mk_forms) and edge functions (marketing-hub, proposal-ai).
- Base-only on top of Enterprise's hub: `MarketingPage({ embedded })` (no own title / Overview tab, starts on E-mail); an AI bar `MhAiBar` (`.gai-*`) on E-mail / Social / Calendar — say what to promote → "Write the e-mail" (composer with the AI brief) or "Plan the posts" (AI series), with idea chips; recurring posts in `PostEditor` (Repeat: Once / Every week / Every 2 weeks / Every month × 2–52 → one series of scheduled posts, `repeatAt`, `REP_LABEL`).
- Enterprise: if you want recurring posts or the AI bar, they're in Base's MarketingHub.tsx (search "BASE:").
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-17 04:50 · Enterprise · Marketing: post preview / calendar can take the whole column; Audiences in the modern look
- files: `src/components/pages/contacts/ContactExport.tsx`, `MarketingOverview.css`, new `src/components/pages/contacts/AudiencesModern.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+8)
- Social › post editor: a round button on the Preview and on When. The preview can grow over the calendar (the column also widens 400 → 600px, the post at about its feed size), or the calendar can grow over the preview (taller days showing the first planned post + "+N more"); the other one folds into a slim bar (When shows the date · time) that brings it back. Heights glide (Web Animations, FLIP), the width with a grid transition.
- Audiences: Lists / Do not contact, the search ("Find a list" / "Find an address or reason") and "New list" moved into the page's bar right of the tabs (the line of explanation is now the switch's tooltip). The panel fits the screen: the side list, the conditions, the preview and the addresses scroll inside. Look: white 26px cards; the picked list a pine pill with a lime count, icons in circles; the editor's head compact (name left; type + Contacts/Companies and the actions right — delete and export as round icons); conditions as soft-grey pill rows with white pill fields; pill buttons; "Will receive it" compact; Do not contact with pill fields.
- deploy: written to the Mac; user to commit

### 2026-11-17 04:30 · Base · Sidebar v6: the floating card back in Next's dark green
- files: `src/base/framework/AppLayout.css` (appended "Sidebar v6")
- Same floating card and modes as v5, now in the pine gradient with a soft emerald glow on top; light icons and labels, white-glass hovers; the open page a neon-lime pill with a pine icon (slides + hops); Home a glass circle with a lime mark; Search a glass pill; avatar emerald with a lime ring; tooltips pine.
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 23:00 · Enterprise · Calendar in Base's modern look (consultancy week / month and the sales week)
- files: new `src/components/pages/calendar/CalendarModern.css` (copy of `src/base/pages/calendar/CalendarModern.css`, selectors widened to `:is(.cal, .sc).cal-v3.cal-mod`, + an Enterprise block), `CalendarPage.tsx`, `SalesCalendar.tsx`, `InvitesTray.tsx` + `.css`, `CalendarSettingsModal.tsx` + `.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+24)
- Look only, copied from Base (2026-11-15 04:10 / 05:20 / 21:15 / 21:25 / 21:40 / 21:55): grey canvas, white pill header, green view slider, the week / month as white 24px cards, lime today, round month days (the "Nd" pill only when there's billable time), the date picker, the Outlook event card, "My calendar" compact with the new people picker (`.cwp`, search over 7), the bell tray (light header, empty state, no bottom Close) and "My time off" (`cws-mod`, with the link to Settings › Calendar).
- Outlook: the eye-button became Base's "Other calendars" drop-down (Outlook only — Enterprise doesn't read Google Calendar), with "Connect or manage your accounts" → Settings › Integrations. Outlook events tinted blue (`#0f6cbd`) everywhere.
- Enterprise-only parts in the same look: the billing-line picker (`cv-line-pop`), the days/hours breakdown, and the sales week (`SalesCalendar`: root `cal-mod`, same header, no aurora, grid one white card, one-line day heads, lime today).
- deploy: written to the Mac; user to commit

### 2026-11-16 22:45 · Base · Sidebar v5: a white floating card in the app's look
- files: `src/base/framework/AppLayout.css` (appended "Sidebar v5")
- The rail floats 10px off the edges as a white 26px card on the grey canvas (same widths, so pages don't move). Ink icons, soft grey hovers; the open page is a deep-pine pill with a lime icon that slides between pages (spring) and gives a small hop; Home is a lime mark (pine when you're on it); Search a soft grey pill with a white ⌘K; account avatar pine with a lime ring; lime glow follows the pointer; tooltips pine.
- Pinned open / pinned closed / labels modes unchanged (Expand / Collapse button, same pages).
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 22:50 · Enterprise · Companies & Contacts pop-ups: fields line up, chips and notes in the new look
- files: `src/components/pages/companies/{CrmModern.css, CompaniesPage.tsx}`, `src/components/pages/contacts/ContactsPage.tsx`
- Labels stay on one line (hints shorten with "…" and show whole on hover), so the fields of a row always line up — the contact's Language field sat lower than LinkedIn because its hint wrapped to two lines. Shorter hints: "Groups contacts by language", "Guessed from the name" (full text as tooltip). Checked every row of both pop-ups at 1280 / 1440 / 1913 with a script (same top, same height).
- Linked companies / people with access: 40px pills, icon in a white circle, round ×. Notes without the resize grip. Phone extension after a hairline. Required asterisk in olive.
- tags: PORT?
- deploy: written to the Mac; user to commit

### 2026-11-16 22:30 · Enterprise · Companies & Contacts pop-ups: every field and dropdown in the new look
- files: `src/components/pages/companies/CrmModern.css` (v7, scoped to `.dw.dw-mod`), `src/components/framework/Select.tsx` (KERNEL-adjacent framework: the menu gets `is-mod` when its trigger sits in `.dw-mod` or `[data-sel-modern]` — nothing changes elsewhere)
- Text fields, phones (+ext), selects, pickers ("Link existing contact", people), dates, multiple choice and "What it is to you" are now 48px soft pills (labels set in, lime ring on focus, white on focus); select chevrons sit in a white circle that turns lime when open; notes are a rounded block; switches are lime when on; section sub-heads get a small lime icon circle.
- Menus opened from these fields (Select, multiple choice, types, contact / people pickers, address suggestions) are rounded white cards: pill options, a grey hover, the choice on a pale-lime pill with a lime tick, the search as a grey pill.
- tags: PORT? (Base's own pop-ups use the old `.dw` look)
- deploy: written to the Mac; user to commit

### 2026-11-16 21:45 · Enterprise · Companies: "What it is to you" is a searchable dropdown (fits hundreds of types)
- files: `src/components/pages/companies/{CompaniesPage.tsx, CrmModern.css}`, `src/components/framework/i18n/{en,es,de,nl}.json` (+10)
- The company pop-up listed every type as a chip to tick — unusable with hundreds of types. Now the field shows only the types it has (chips with ×; CRM / Client / In sales fixed with "auto" when they come from the data) and "Add a type…" opens a list with search, keyboard (↑ ↓ Enter, Backspace removes the last) and ticks; the ones it had stay on top while the list is open. New `RelPicker` (built on the `mc` multi-select look). Contacts take their types from their companies, so they follow.
- tags: PORT? (`src/base/pages/companies/CompaniesPage.tsx` has the same chip list)
- deploy: written to the Mac; user to commit

### 2026-11-16 15:50 · Enterprise · "Connect LinkedIn" greyed out on the live site: the app's public client IDs as a fallback
- files: `src/components/api/connectedAccounts.ts`
- On nextcrm.atebiz.com the Integrations "Connect" buttons for LinkedIn (and Google / Meta) were disabled for everyone: `providerReady()` reads `VITE_LINKEDIN_CLIENT_ID` etc., which exist only in the local `.env` (not committed) and not in Vercel — so it worked on localhost only. The public client IDs (MS, Google, Meta + config, LinkedIn) are now built in as fallbacks; `.env` / Vercel values still win.
- Still needed outside the code (user): the live address `https://nextcrm.atebiz.com/settings` must be an authorised redirect URL in the LinkedIn app (and in the Google OAuth client / Meta app for those), and the VITE_* values should be added in Vercel too.
- tags: PORT? — **Base**: `src/base/api/connectedAccounts.ts` reads the same VITE_* values, so Base companies on the live site have the same greyed-out buttons until Vercel has them (or Base copies these fallbacks).
- deploy: written to the Mac; user to commit

### 2026-11-16 15:40 · Enterprise · LinkedIn posts: real @mentions, the link's picture as a card, and a sturdier "Connect" window · **DB** SQL 146 (applied)
- files: `src/components/pages/contacts/{ContactExport.tsx, MarketingOverview.css}`, new `src/components/pages/contacts/PostMentions.tsx`, `src/components/api/{marketingHub.ts, connectedAccounts.ts}`, `src/components/framework/i18n/{en,es,de,nl}.json` (+22), `supabase/functions/marketing-hub/index.ts`, new `sql/146_marketing_post_mentions.sql`
- **@mentions**: in the post editor, "@" opens "Tag on LinkedIn" — colleagues who connected LinkedIn (their member URN, kept in `connected_accounts.settings.urn/li_name`) and CRM companies with a LinkedIn page (`companies.linkedin`), or a pasted page link / number. The page's URN + exact name come from LinkedIn (API when allowed, else the public page). Text keeps "@Name"; `marketing_posts.mentions` keeps [{name, urn, kind}] and marketing-hub writes LinkedIn's `@[Name](urn)` (and `#word` as LinkedIn hashtags) when the post goes out. Chips under the text; a page whose name couldn't be confirmed asks to check it (LinkedIn only links exact names). People who never connected LinkedIn can't be tagged (LinkedIn's API gives no one else's ID).
- **Link card**: the link's Open Graph card (title, picture, site) is read by marketing-hub `link_meta` (direct, else microlink.io), shown in the preview and on the board card, kept in `marketing_posts.link_preview`; on LinkedIn a link without a photo goes out as an article card with that picture as thumbnail (WebP/AVIF converted to JPG via wsrv.nl). With a photo, the link goes at the end of the text.
- **Connect window** (`connectedAccounts.addAccount`): LinkedIn / Google / Microsoft sign-in pages cut the popup off from the app (Cross-Origin-Opener-Policy), so `popup.closed` read true at once and the app said "closed" while the person was still signing in (first-time sign-ins failed; already-authorised ones redirected fast enough to work). Now it waits until the app has the focus back for 2 s, up to 10 min; the code still arrives by BroadcastChannel / storage.
- **Edge function `marketing-hub`** v6: new actions `link_meta`, `li_people`, `li_resolve` (+ `li_resolve_test`, cron key only). Old actions unchanged.
- **DB (146)**: `marketing_posts.mentions jsonb default '[]'`, `marketing_posts.link_preview jsonb`. Applied 2026-11-16.
- tags: DB / PORT? (Base's `src/base/api/connectedAccounts.ts` has the same popup wait — same fix applies)
- deploy: written to the Mac; SQL 146 applied; marketing-hub v6 deployed; user to commit

### 2026-11-16 15:20 · Base · Orbit and Billing use the app's own scrollbar
- files: `src/base/framework/AppLayout.css` (appended)
- `.ct-scroll`, `.co-scroll`, `.cl-scroll` (Orbit: contacts, companies, clients), `.bz-scroll` (Billing) and the client pop-up's scroll get the same scrollbar as Deals' list: thin, green-tinted rounded thumb on a clear track (darker on hover).
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 15:10 · Base · Deals: filters from the last visit never open the page empty
- files: `src/base/pages/sales/sales/SalesPage.tsx` (`staleChecked`, `staleView`, a once-per-visit check after `ready`; note `.sl-stale` above the list), `src/base/pages/sales/sales/SalesModern.css` (`.sl-stale`)
- The deal filters are kept per browser (`np-deals-view`). When on arrival they hide every deal (a stage / pipeline that changed, a status nobody is in…), they're switched off once, a lime note says so and offers "Put them back". Filters you set during the visit are never touched.
- tsc clean. Deploy: device, committed locally.

### 2026-11-16 13:55 · Enterprise · Long task names wrap and the field grows (no more hidden text after a line or two)
- files: `src/components/framework/MentionInput.css`, `src/components/pages/homepage/shared/{HomeShared.css, HomeTodo.tsx}`, `src/components/pages/sales/sales/SalesPage.css`
- One-line @-mention fields (`.mi-single`: Tasks quick-add box, steps, the deal's "Task name" and its edit card) were fixed at one line and scrolled sideways, so a long task couldn't be read or edited. They now wrap and grow (up to ~6 lines, then scroll); Enter still adds / saves. The quick-add box keeps its look on one line; its flag and + sit on the last line. The old to-do card (`HomeTodo` › `.hs-add`, used in the Sales calendar) gets a growing textarea instead of an `<input>`.
- tags: PORT? (Base has its own `src/base/framework/MentionInput.css` with the same `.mi-single` rule, and `src/base/pages/homepage/shared/HomeShared.css`)
- deploy: written to the Mac; user to commit

### 2026-11-16 12:45 · Enterprise · IONOS Mail: connect IONOS mailboxes and send e-mails and campaigns from them · **DB** SQL 145 (applied)
- files: `src/components/api/connectedAccounts.ts`, `src/components/api/marketingHub.ts`, `src/components/pages/settings/integrations/{Integrations.tsx, IntegrationsModern.css}`, `src/components/pages/settings/SettingsPage.tsx` (tile text), `src/components/pages/contacts/ContactExport.tsx`, `src/components/framework/i18n/{en,es,de,nl}.json` (+45), `supabase/functions/marketing-hub/index.ts`, new `sql/145_connected_smtp.sql`
- **Settings › Integrations › IONOS Mail** (new app): e-mail address + mailbox password (+ optional sender name; "Server settings": IONOS server picker in a custom dropdown or another SMTP server, port 465 SSL/TLS or 587 STARTTLS). `marketing-hub` signs in once (no host given = tries smtp.ionos.es/.com/.de/.co.uk/.fr/.it/.mx) and stores the account as `provider = 'smtp'`, `services ['mail']`, `settings {host, port, label}`; the password goes to `connected_account_tokens.access_token` (service role only, never back to the browser). Check now signs in again; Remove uses `connected-accounts › disconnect` as for the others.
- **Sending**: IONOS mailboxes appear in Marketing › e-mail studio › Who sends it (IO mark) and work for test sends and campaigns. `marketing-hub › mail_send` speaks SMTP itself (Deno TLS, AUTH PLAIN, MIME base64 HTML). The campaign runner waits 8 s between e-mails of an SMTP mailbox (≈450/h — IONOS allows 500/h, fewer in a contract's first month); 421/45x answers = throttled → retried later.
- **Edge function `marketing-hub`** v2: new actions `smtp_connect`, `smtp_check`, `smtp_probe` (IONOS hosts only, no login — reachability check: OK from Supabase on 465); `mail_send` accepts `smtp` accounts. Old actions unchanged.
- **DB (145)**: `connected_accounts_provider_check` + `'smtp'`; `connected_accounts.settings jsonb not null default '{}'`. Applied 2026-11-16.
- **For Base (PORT? / heads-up):** Base's panel maps unknown providers to "Outlook" (`appsOf`), so an IONOS mailbox would show there as Outlook; and `connected-accounts › check` on a `smtp` row would try a token refresh and mark it as an error. Port the Enterprise `appsOf` / `checkAccount(id, provider)` / `SmtpForm` bits, or filter `provider = 'smtp'` out of Base's list.
- tags: DB / PORT?
- deploy: written to the Mac; SQL 145 applied; marketing-hub v2 deployed; user to commit

### 2026-11-16 11:20 · Enterprise · Companies & Contacts: pop-up header in order (types on one line, +N for the rest); lists as on Clients
- files: `src/components/pages/companies/CompaniesPage.tsx` (new `HeroTagRow`), `src/components/pages/contacts/ContactsPage.tsx`, `src/components/pages/companies/CrmModern.css` (v5 + v6)
- Pop-up header: eyebrow, name, who/where, then the types (Client, In sales, CRM, your own…) on ONE line — as many as fit, then "+N", which opens a floating card with all of them and where each comes from (scrolls for 50+). The detail tiles beside it keep whole tiles: the ones that don't fit drop out of sight instead of being squeezed into each other.
- Lists: one white pill per row on the canvas (radius 20, 68px, lime ring on hover), the column titles on the canvas and sticky, everything left-aligned — the same as the Clients and Projects lists (no white sheet behind the rows any more).
- tags: PORT? (Base's company / contact pop-ups and lists, if it wants the same)
- deploy: written to the Mac; user to commit

### 2026-11-16 10:55 · Enterprise · Deals: the phase no longer jumps back after moving a deal
- files: `src/components/pages/sales/trackings/TrackingDetail.tsx`, `src/components/pages/sales/sales/SalesPage.tsx`
- Cause: the deal page took its phase from the deals list, which is refreshed in the background after a change; reopening a deal before that refresh showed the old phase, while its phase dates (read fresh) were already right. Now the deal page reads its phase and status fresh when it opens, and tells the deals page at once when they change (`onPatch`), so list, board and the reopened deal agree.
- tags: PORT? (src/base/pages/sales/trackings/TrackingDetail.tsx has the same pattern)
- deploy: written to the Mac; user to commit

### 2026-11-16 08:30 · Enterprise · Settings › Integrations in Enterprise; campaigns from any connected mailbox; Social board + LinkedIn auto-publish · **DB** SQL 144 (applied)
- files: new `src/components/pages/settings/integrations/{Integrations.tsx, Integrations.css, IntegrationsModern.css, brandIcons.ts}` (copies of Base's, same `.ig-` classes), new `src/components/api/connectedAccounts.ts` (copy of `src/base/api/connectedAccounts.ts`, import path only), new `src/components/api/marketingHub.ts`, `src/components/pages/settings/SettingsPage.tsx` (tile + view "integrations"), `src/components/pages/contacts/ContactExport.tsx`, `src/components/pages/contacts/MarketingOverview.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+60), new `supabase/functions/marketing-hub/index.ts`, new `sql/144_marketing_senders_autopublish.sql`
- **Settings › Integrations** now also in Enterprise: the same panel, tables and edge function `connected-accounts` as Base, so an account connected in either app is the same one. The OAuth return still lands on `/settings` (the copied module catches it). **IDEA→ENT / for Base:** `src/components/api/connectedAccounts.ts` is now a shared copy — Base may import it (and the panel) instead of keeping its own; until then, changes to Base's panel/API → PORT? to these copies.
- **E-mail studio › Who sends it**: cards for "Your Outlook" (outlook-sync, as before) + every Gmail / Outlook account you connected; "@ Another address" = a Send-as / alias address of the chosen mailbox (verification notes in the field); "Connect a mailbox" → Settings › Integrations. Saved in `marketing_campaigns.sender_account`. The runner and the test send go through the edge function `marketing-hub` (`mail_send`: Gmail API / Graph `/me/sendMail`) when an account is chosen.
- **Template preview**: one big dialog — the e-mail (desktop / phone) on the left, name, subject, preview line, used / edited and Use / Edit on the right.
- **Social**: view (Scheduled / Drafts & ideas / Published / All) and network as dropdowns + search + Import / Plan with AI / New post in the page bar; Scheduled = a two-week board (Mon–Sun × 2, chips with time + networks, + on hover to add); the other views = compact cards; side: Channels (connected LinkedIn "Publishes by itself" + manual ones), this month, ideas.
- **Post dialog** rebuilt: networks in the header, text (+ AI popover) and media/link on the left; "When" = a month with dots on days that already have posts (hover lists them: time, networks, title) + time + series + "Publishes by itself on LinkedIn" (on by default when LinkedIn is connected); preview below.
- **LinkedIn publishing**: Publish dialog has "Publish on LinkedIn" (edge function `marketing-hub` › `social_publish`, posts as the member via `/rest/posts`, picture via the Images API, falls back to `/v2/ugcPosts`); scheduled posts with `auto_accounts.linkedin` go out by themselves (pg_cron `marketing-social-due` every 5 min → `mk_social_due()` → `marketing-hub` › `social_due`, keyed with `cs_cron_key`). Outcome in `results.linkedin` (`url`, `urn`, `auto_at` or `auto_error`); a LinkedIn-only post becomes published (or failed).
- **DB (144)**: `marketing_campaigns.sender_account uuid → connected_accounts(id) on delete set null`; `marketing_posts.auto_accounts jsonb default '{}'`; `mk_social_due()` (security definer, not callable by anon/authenticated); cron job `marketing-social-due`. Applied 2026-11-16.
- **Edge function `marketing-hub`** (new, Enterprise-owned): deployed v1 (verify_jwt on). Uses the secrets already set for `connected-accounts`.
- tags: DB / PORT? (Integrations panel + connectedAccounts API are copies of Base's) / IDEA→ENT
- deploy: written to the Mac; SQL 144 applied; marketing-hub deployed; user to commit

### 2026-11-16 08:05 · Base · Home: the greeting as a white header bar
- files: `src/base/pages/homepage/HomeModern.css` (v2 block at the end)
- The greeting line is a white 24px bar: the date as a small uppercase eyebrow with a lime dot, "Working late, Inder" under it (24px), the bell (soft grey circle) and the board button (lime) on the right. The figures sit right under it.
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 07:55 · Base · Home redone after the user's references (Moneed / Flux / TaskLab)
- files: `src/base/pages/homepage/HomeModern.css` (rewritten; already imported by HomePage.tsx)
- Looks only — still 100% customisable (same cards, sizes, drag / resize). No green hero block any more: light grey canvas, a large ink greeting with the date in a white pill, white bell and lime board button; the figures are their own 26px cards with very large numbers (first deep pine, second neon lime, the rest white) and a small icon circle on each label; every card headed by an icon in a grey circle (calendar, tasks, closing, attention, stages) with a muted eyebrow and bold title; big figures inside sales cards; every switch a grey track with a lime pill; links as white hairline pills; today's date in a lime circle; task rows soft grey with white date pills (red when late); "all good" messages on lime.
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 07:35 · Base · Home modern look rolled back
- files: `src/base/pages/homepage/HomeModern.css` (emptied — the home looks exactly as before 07:25)
- The user didn't like it. The import stays (harmless) for the next attempt.

### 2026-11-16 07:25 · Base · Home in the modern look (still 100% customisable)
- files: new `src/base/pages/homepage/HomeModern.css`; `src/base/pages/homepage/HomePage.tsx` (one line: `import "./HomeModern.css";` after HomePage.css — committed alone; the other chat's uncommitted alert lines in that file stay uncommitted)
- Looks only — same cards, sizes, drag / resize / customise. Grey canvas; cards white 24px with the soft shadow; titles with a pill eyebrow; the hero 28px with its first figure in lime and the others as glass tiles (bigger numbers, lift on hover); every switch (5 days / Month, Mine / Team, Open / Blocked / Done, Closing / Team) a soft track with a Next-green pill; links as pills; calendar strip soft grey with a white pill on today; task rows soft grey (white + lift on hover), quick-add with a lime ring, counts in lime.
- Selectors are `html .home.home.home …` because Base's theme rules are `.home.is-cons …`.
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 07:00 · Base · Client pop-up › Contracts: each contract opens the full contract window
- files: `src/base/pages/clients/ClientWorkspace.tsx` (imports `SignedContractView` + `linesContractFigures`; state `scv`; `openScv(tid, gl, ct)` builds the row like ContractsBoard does; the window renders inside the workspace), `src/base/pages/clients/ClientWorkspaceModern.css` (`.cw-k-open`, `.cw-k-open-t`)
- In Orbit › Clients › a client › Contracts, every contract has an "Open contract" button (and its name is clickable): it opens the same contract window as Enterprise's Clients › Contracts — contract value, this year, term with days left, year by year (recurring / increase / one-time / partner / net), every product's price build-up, terms (length, renewal, increases, invoicing, currency), parties and signatories, Edit, Open the deal. Saving there reloads the client's products.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 06:40 · Base · Reports page (port of Enterprise's)
- files: new `src/base/pages/reports/` — `ReportsPage.tsx` (= Enterprise `SalesReport.tsx`), `ReportsHome.tsx`, `ReportCharts.tsx`, `ReportShare.tsx`, `reportsEngine.ts` (= Enterprise `salesReportEngine.ts`), `SalesReport.css`, `ReportsHome.css`, `ReportsModern.css`; `src/base/BaseApp.tsx` (route `/reports`, page access `reports`), `src/base/framework/Dock.tsx` (Reports after Billing, bars icon)
- Copied from Enterprise's working copy of today (incl. its uncommitted SalesReport.tsx / ReportsModern.css), only import paths changed: Base framework (Select, DatePicker, exportFile), `components/framework/ErrorBoundary`, Base companiesApi / SalesMultiFilter / salesApi / trackingFieldsApi / contractsApi / catalogApi / pipelineApi / clients. ReportsHome uses Base's `HomeBoard` (dropped the kit `label` and the `duo` prop Base's board doesn't have).
- Base's own `pages/sales/extras/salesReportEngine.ts` (ExportModal, ContactExport) is untouched — the page has its own engine copy so the two don't fight. Enterprise: when you change the report engine, tell Base so we can copy it again.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 06:20 · Enterprise · Marketing › E-mail: steady tabs, a one-screen e-mail studio, templates edited on their own, list or cards
- files: `src/components/pages/contacts/ContactExport.tsx`, `src/components/pages/contacts/MarketingOverview.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+70)
- Tabs: their size now depends on the screen width only (labels from 1760px, icons below), never on the open tab — clicking no longer moves the tabs under the pointer.
- Composer rebuilt as a studio that never scrolls the page: header pill with name + the 3 steps + Save; the step on the left, the preview on the right (desktop / phone frame, sample contact). Audience: lists as cards (+ a searchable dropdown when there are more than 6), reach banner with faces, From / Reply-to side by side. Message: subject + preview line in one row, one toolbar (format, Personalize, Form, Templates, HTML, Write with AI) whose choices open as small floating panels (AI tone/language as pills; start from / save as template side by side; the unsubscribe line edited in a panel); only the text scrolls. Review: checks as pills + tracking toggles | a pine send card (to / from / subject, test, schedule with date + TimePicker, send).
- Templates: "New template" and "Edit" open the same studio in template mode (no audience, no sending; Save template). Cards show a real thumbnail of the e-mail; preview dialog with desktop / phone.
- Campaigns and templates can be shown as a list or as cards (switch beside the search, saved per user in prefs `mkEmailLayout`).
- Class prefixes `mst-` / `mtp-` (the old `cp-` clashed with CatalogPage.css).
- tags: —
- deploy: written to the Mac; user to commit

### 2026-11-16 06:05 · Base · Task pop-up: a small neon touch on Enterprise's layout
- files: `src/base/pages/homepage/shared/TasksModern.css`
- Layout untouched. "Task" tag, @ hint, step count, tags and the side icons in lime; the facts strip soft grey with Status and Priority as strong coloured pills (Doing amber, New blue, Blocked violet, Done green, Urgent red, High amber), Due a white pill (red when late); Mark done in Next green with a lime arrow; description / steps on soft grey with a lime ring when writing; the steps meter green → lime with the % in a mint pill, done steps green with a lime ring; Comments/History switch in ink; linked values bold.
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 05:50 · Base · Task pop-ups back to Enterprise's design (+ a light touch)
- files: `src/base/pages/homepage/shared/HomeTodo.tsx` (TicketDrawer: the guided new-task cards, progress header and title move are gone — the drawer is Enterprise's again, keeping only several owners: Owner(s) tile with `OwnerStack`, `OwnersMenu`, `toggleOwnerOf`), `src/base/pages/homepage/shared/TasksModern.css` (every `.td.tdx` / `.td-back` override from v1–v6 removed)
- What stays on top of Enterprise's look: rounder window (22px), pill buttons, Create / Mark done / Comment in Next green, a one-line comment box, a rounded time-in-stage bar, overlapping avatars; a new task is only as tall as its content.
- The Tasks page itself (one-row header, sliding Mine/Team/Unassigned, compact cards) is unchanged.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 05:30 · Enterprise · Marketing › sent campaign: one-row hero, no page scroll, Outlook send errors fixed
- files: `src/components/pages/contacts/ContactExport.tsx`, `src/components/pages/contacts/MarketingOverview.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+5), `supabase/functions/outlook-sync/index.ts`
- Report hero in one row: back, icon, name + subject, Audience / From / Sent chips, actions. Retry / Pause / Cancel / Follow up / Duplicate are round icon buttons whose name slides out on hover. Merge fields in the subject are legible (lime on pine).
- The report fits the screen at any width: only the recipients list scrolls (the page had a small vertical scroll). Six figure cards stay in one row down to 1280.
- Send fix: "Graph error UnknownError" came from Word-pasted bodies (`<o:p>`, `class="MsoNormal"`, `<!--[if …]>`). The runner now strips that markup before sending, retries a Microsoft server error once after 20 s, and shows a readable reason ("Microsoft server error — press Retry" / "Outlook wasn't connected").
- outlook-sync `mail_send`: the same clean-up server-side; a transient Graph error on /send is retried only while the message is still a draft (never sends twice), then falls back to plain sendMail. Same action and params.
- tags: edge function changed (not deployed: the repo version also carries earlier undeployed changes)
- deploy: written to the Mac; user to commit and run `npx supabase functions deploy outlook-sync --project-ref eloadnqjcrvdnvdcoqap`

### 2026-11-16 05:25 · Base · New task fits without scrolling (dropdowns, slim header)
- files: `src/base/pages/homepage/shared/HomeTodo.tsx` (creatingMode: cards 2+3 merged into "Who, how urgent, by when?" with three dropdowns — Responsible opens the owners picker, Priority the priority list, Due the date picker with ×; guide is now 3 steps), `src/base/pages/homepage/shared/TasksModern.css` (v6)
- Header is one 46px line (New task · hint · 1/3 progress · ×). Shorter fields (title 17px, details grow from 44px), tighter cards on both sides. At 1440×800 the whole pop-up is ~550px tall — no scroll.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 05:05 · Base · Task pop-ups in Next's colours (no black)
- files: `src/base/pages/homepage/shared/TasksModern.css` (v5 block)
- Both pop-ups: pine header with the soft green glow (as the company/contact pop-ups), title in white, Status / Priority / Owners / Due as glass pills, "Task" tag and Mark done in lime, round glass icons.
- New task: picked people / priority / due in Next green (urgent red, high amber), ticks in lime, Create task in Next green. No black anywhere.
- Open task: section titles get a small green dot, the steps meter and Comments / History switch in Next green, Send in Next green; Opened row aligned with the cards above.
- CSS only. Deploy: device, committed locally (user pushes).

### 2026-11-16 04:40 · Base · New task: one panel, guided by four numbered cards (neon look)
- files: `src/base/pages/homepage/shared/HomeTodo.tsx` (TicketDrawer creatingMode: the 3-step wizard is gone; `guideSteps`/`guideDone`; header `.tdg-head` with progress; left column `.tdg` with 4 cards; footer Cancel + Create), `src/base/pages/homepage/shared/TasksModern.css` (wizard CSS replaced by `.tdg-*`)
- Everything is on screen at once, two columns: left 1 What needs doing? (title + details) · 2 Who's responsible? (people as toggle pills, the first is "Lead"; >18 people → "Someone else" opens the picker) · 3 How urgent, and by when? (priority chips · Today / Tomorrow / In a week / another day / ×) · 4 Break it into steps (optional); right Details + Linked to.
- Each card's number turns into a lime tick once it's filled; the black header shows "3/4" with lime bars. Selected chips are black with lime accents; Create task is a lime pill (⌘ Enter). Enter in the title jumps to the details.
- Existing tasks unchanged.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 04:10 · Enterprise · Marketing › E-mail: columns in Actions, steady tabs, the campaign pages modernized
- files: `src/components/pages/contacts/ContactExport.tsx` (Actions › "Columns of the list" via `HubCtx.colsTick`; `CampaignReport` header rebuilt), `src/components/pages/contacts/MarketingOverview.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+11)
- The columns button left the list header: it's "Columns of the list" in the Actions menu (E-mail tab), opening the same chooser under the Actions button.
- Tabs: no size change on hover or click any more (labels always shown; where the bar holds a tab's tools, all tabs are icons with tooltips) — the pointer no longer lands on another tab.
- Row hover: the lime ring was clipped on the left (the list bled 6px past a clipping parent) — fixed.
- A sent campaign: a pine hero (back, lime icon, status, name, subject, actions as pills, audience / from / date chips, progress while sending); the six figures as cards (Delivered green, Opened lime, rest white with bars; click to filter people); opens chart and links in white sheets with pine/lime icon circles (busiest moment in lime, links as filled bars); recipients as pill rows with coloured tags.
- A draft / scheduled campaign (composer): header as a white pill (pine back, name, status, Save draft), steps as one pill row (pine active, lime done), Write with AI as a dark card, soft inputs, list choices as soft cards, review checks as pills.
- tags: —
- deploy: written to the Mac; user to commit

### 2026-11-16 04:05 · Base · New task as a guided 3-step flow; side cards fixed
- files: `src/base/pages/homepage/shared/HomeTodo.tsx` (TicketDrawer: `wz`/`wzDir`/`goStep`; stepper `.tdw-steps`; step 2 block `.tdw-who`; footer Back / Create now / Next / Create task; Enter in the title goes to the next step), `src/base/pages/homepage/shared/TasksModern.css`
- New task keeps the two columns (left: the step, right: Details + Linked to, always there). Steps: 1 What (title + description) · 2 Who & when (owners inline with search, priority chips, due chips Today / Tomorrow / In 3 days / In a week / a date / No date) · 3 Steps (optional). Each step slides in from the side it comes from; done steps get a tick. "Create now" saves at any step once there's a title.
- Open task: every side card has the same 14px top padding (an old `.tdx .td-side > * + * { padding-top: 0 !important }` was eating it on Linked to / Time in each stage); the time bar is a rounded track with rounded segments.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 03:30 · Enterprise · Marketing › E-mail: tools in the page bar, chosen figures, a list with chosen & ordered columns
- files: `src/components/pages/contacts/ContactExport.tsx` (new `EmailTab`, `EM_COLS`/`EM_KPIS`, `EmColumns`, `MkTabs`, `HubCtx.bar`; `TemplatesView` takes the bar's search), `src/components/pages/contacts/MarketingOverview.css`, `src/components/pages/sales/sales/DealKpis.tsx` (new export `KpiStrip<C>` + `FigDef<C>`: the Deals figure cards and picker for any page — DealKpis itself unchanged), `src/components/framework/i18n/{en,es,de,nl}.json` (+42)
- Page bar: the tabs are icons (the open one shows its name, the green pill follows); right of them a slot (`.mkh-tools`) where E-mail puts Campaigns / Templates, a status dropdown (All · In progress · Drafts · Sent), the search and New e-mail — one row, shrinking via a container query so it never overflows.
- Figures: 1–6 per user out of 14 (`prefs.mkEmailKpis`), the Deals look (pine, green, then lime, then white) with ⇄ per card and the picker.
- List: one white pill per row; Campaign is always first, then the user's columns out of 13 (audience, status, sent, opened, clicked, replies, bounced, opted out, failed, when, created, from, progress) — ticked and dragged into order in the columns chooser (`prefs.mkEmailCols`); headers sort.
- tags: —
- deploy: written to the Mac; user to commit

### 2026-11-16 03:30 · Base · Tasks v3: app view switch, one-line comments, aligned side, focused New task
- files: `src/base/pages/homepage/shared/HomeTodo.tsx` (scope switch gets a sliding pill: `scopeRef`, `scopePill`, measured in a layout effect + ResizeObserver; buttons carry `data-k`), `src/base/pages/homepage/shared/TasksModern.css` (v3 block)
- Mine / Team / Unassigned now look and move like Deals' List / Board: white 44px pill track, a green gradient pill that slides (spring) to the open one, hover lift on icons, press scale. The whole header row is 44px; search shrinks, then the count text (<1720px), then the scope icons (<1480px) so it stays one row.
- Comment box is one line: avatar · text · Send (it grows only while you write more lines). The hint line under it is hidden.
- Side cards: Tags, Linked to and Opened/Updated share one label column (96px) so values line up; header bits (kind, ref, round icons, pills, clear ×) centred on one line.
- New task: a focused 700px form, white, one column — title, Priority/Owner/Due pills, Description, Steps, Tags, Linked to as a 2×2 grid; opens near the top; Cancel / Create task at the foot.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 02:55 · Base · Billing › When invoices are made: two parts + "N days before the month ends"
- files: `src/base/pages/billing/AutoInvoiceModal.tsx`, `src/base/pages/billing/BillingModals.css` (appended `.bza-part*`, `.bza-modes`, `.bza-days`, `.bza-step`, `.bza-preview`, `.bza-now-grid`), `src/base/pages/billing/billingApi.ts` (`cutoffOf` reads negatives), `src/base/pages/calendar/CalendarPage.tsx` (the calendar's cutoff marker reads negatives), new `src/base/sql/143_base_cutoff_before_month_end.sql` (applied)
- The modal is two separate cards: **Make the invoices automatically** (toggle in its header; cutoff; made as; its own foot with the next cutoff + Save) and **Bill now** (up to · made as Drafts/Sent — now its own choice, no longer borrowed from the automatic setting · estimate · Make invoices). Recent runs below. The footer with only Close is gone (X in the header).
- Cutoff of the month has three modes: Last day · A set day (a 7×4 grid of days 1–28 instead of the select) · Before the month ends (stepper 1–27 + quick 3/5/7/10/15). A preview shows where it lands this month and the next two.
- `base_billing_settings.cutoff_day`: 0 = last day, 1..28 = that day, −N = N days before the last day (−10 → 20 Nov / 21 Dec). The check is now −27..28 and `base_cutoff_of` handles negatives, so `base_billing_tick` follows without changes. Existing values keep their meaning.
- tsc clean. Deploy: device, committed locally (user pushes). Next free SQL: 144.

### 2026-11-16 02:50 · Enterprise · Marketing: Actions button fixed; neon accents
- files: `src/components/pages/contacts/ContactExport.tsx` (third figure `is-lime`; Customize shortcut C — O was New company), `src/components/pages/contacts/MarketingOverview.css`
- The Actions launcher was squeezed into a 44px circle and clipped its own "Actions" label on hover: now a pine pill with lime dots whose label slides out (lime ring when open).
- Neon: a lime glow on the canvas and a lime dot by the title; the active tab's count, Sending / banner pulses, the third figure (lime card), panel icons as pine circles with a lime glyph, lime arrows on the tab links, "Today" chip, the top item of each list, click-rate bars and the first "Needs you" in lime; lime ring + glow on hover.
- tags: —
- deploy: written to the Mac; user to commit

### 2026-11-16 02:20 · Base · Tasks v2: compact header, compact cards, light pop-up header
- files: `src/base/pages/homepage/shared/HomeTodo.tsx` (page header and filter bar merged into one row `.tkp2-head.is-one`; `.tkp2-count` on the subtitle), `src/base/pages/homepage/shared/TasksModern.css` (rewritten)
- Page: one 40px row — title + count · Mine/Team/Unassigned · quick chips · priority · saved views · search · shortcuts · New task. The priority select is as wide as its text (was a fixed 138px → overlapped the bookmark in Spanish).
- Cards: owners top-right, no empty foot row (it only shows when a step waits for you); an overdue chip shows only "N days late"; ~95px instead of ~180px.
- Pop-up (new and open): the pine header is gone — white, three tight lines (kind/ref/actions · title 21px · Status/Priority/Owners/Due as pills + Mark done), ~130px instead of ~215px. A new task is only as tall as its content. Side groups and meta tighter.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-16 02:30 · Enterprise · Marketing: the Clients look; Overview fits one screen; customizing = the home's
- files: `src/components/pages/contacts/ContactExport.tsx`, `src/components/pages/contacts/MarketingOverview.css` (rewritten), `src/components/framework/i18n/{en,es,de,nl}.json` (+14)
- Look (whole Marketing page, `.mk.mkh.mk-mod`): no dark band — title, tabs (white pill, green active), Sending / ready-to-publish pills and the pine actions circle float on the #f1f3f2 canvas, as on Clients. Overview cards: 26px white sheets; figures as the Clients KPIs (first pine, second green, rest white; icon top-right in a mint circle); panels with mint icon circles, soft pill rows with a lime ring on hover; Write with AI is the dark card.
- Customize moved into the Actions menu (group "Overview"); the mkh-cust pill is gone. Customizing now uses the home's own pieces: the dock portaled to body and a library with the home's `hb-lib` markup (search, Everything/Cards/Figures, groups, + Add / Remove).
- Fix: the board's glide animations were broken outside the home (its `--cz-*` tokens weren't defined) — now defined on `.mk-mod`.
- Never scrolls: 18 rows share the height of the screen (`MO_ROWS`); while adjusting, cards may go below the dashed "end of your screen" line (marked coral) and Done asks to make room first. Saved layouts taller than the screen keep what fits.
- tags: —
- deploy: written to the Mac; user to commit

### 2026-11-16 01:40 · Base · Tasks in the modern look + several owners per task
- files: `src/base/pages/homepage/shared/HomeTodo.tsx`, new `src/base/pages/homepage/shared/TasksModern.css`, new `src/base/sql/142_task_co_owners.sql` (applied)
- Look (CSS only, scoped to `.tkp2`, `.tkb`, `.td.tdx`): grey canvas; pill search / New task / scope track (active tab in ink, count in lime); board columns as soft 24px panels, cards white 18px with a priority bar on the left, overlapping avatars; the task pop-up (new and open) has a pine header with the title in white and Status / Priority / Owners / Due as glass tiles, "Mark done" in lime; Description, Steps, Comments and the side groups as white 24px cards; pill buttons, green Create.
- Several owners: `tracking_tasks.co_assignee_ids uuid[]` (142, additive). `assignee_id` stays the main owner (the first ticked), the rest go in `co_assignee_ids` and also join `tracking_assignees` so RLS lets them see it. Ticket gains `coOwners`; helpers `ownersOf`, `toggleOwner`; new `OwnersMenu` (tick several, "Responsible" first) and `OwnerStack` (avatars + "Me & Lucía" / "Me +2"). Used in the pop-up's Owners tile, the board/list owner menu, the home quick-add composer; "Mine" includes tasks you co-own; cards show owners first.
- Enterprise: same table — if Enterprise wants several owners too, read `co_assignee_ids` (nothing breaks if it doesn't).
- tsc clean. Deploy: device, committed locally (user pushes). Next free SQL: 143.

### 2026-11-16 01:40 · Enterprise · Marketing › Overview: modern, fully customizable board of cards
- files: `src/components/pages/contacts/ContactExport.tsx` (new `Overview` + `MO`/`MO_KIT`, header "Customize" button, `ovEdit` state), `src/components/pages/contacts/MarketingOverview.css` (new), `src/components/framework/i18n/{en,es,de,nl}.json` (+78)
- The Overview is now the home page's board (`HomeBoard` from `homepage/HomePage.tsx`, compacting grid): each person moves, resizes, adds and removes cards; saved per user in profile prefs under `mkOverview` (`{v:1, items}`), default layout when none.
- 26 cards in 5 groups: 12 figures (can be e-mailed, delivered + weekly bars, open / click / bounce rate rings, replies, opted out, social views + weekly bars, engagement, form answers, planned 14 days, audiences) and 14 panels (coming up, last campaigns, e-mail funnel, sends by week, needs you, write with AI, social by network, best posts, biggest audiences, forms, drafts, this week, quick actions, latest opt-outs).
- "Customize" pill in the Marketing bar (Overview tab) → adjusting mode: the dock (Cards drawer grouped with add/remove, Reset, Cancel, Done) — same dock as the home and the deal page.
- tags: PORT? (Base has no marketing hub; skip unless it gets one)
- deploy: written to the Mac; user to commit

### 2026-11-16 00:50 · Base · Company & contact pop-ups in Enterprise's modern look
- files: `src/base/pages/companies/CompaniesPage.tsx` (company pop-up header, new exported `DwFact`, CSS import), new `src/base/pages/companies/CrmModern.css` (copied from Enterprise, all blocks up to v4), `src/base/pages/contacts/ContactsPage.tsx` (contact pop-up header, CSS import)
- Port of Enterprise 2026-11-15 04:55 / 11:20 / 21:55, pop-ups only: `.dw.dw-mod` — the pine header is one row (avatar + eyebrow with Client / In sales / type pills + name + sub, then the details as labelled tiles: Website, Email, Mobile, Telephone, Location, Language, LinkedIn, Contacts → its section, "To fill in" in amber → the missing fields; close on the right); sections index as pills (one sliding marker), sections as white 24px cards with icons in circles, soft fields with a lime ring when typing, pill buttons, Save in green. A new record keeps Base's Company / Contact switch in the header. No behaviour change.
- The lists (`co-mod` / `ct-mod`) are not switched on — Base shows them inside Orbit with its own look.
- Note: Enterprise's root `sql/138_tenant_billing_events.sql` and Base's `src/base/sql/138_invoice_contracts.sql` share the number 138 (different folders, both applied/independent); Base's next free number: 142.
- No SQL. tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 22:40 · Base · Invoices open contracts / projects; time by service; a client's Billing tab · **DB** SQL 138 (applied)
- files: new `src/base/sql/138_invoice_contracts.sql` (applied to Supabase), `src/base/pages/billing/billingApi.ts`, `InvoiceModal.tsx`, `BillingPage.tsx`, `BillingModals.css`, `BillingModern.css`, `src/base/pages/calendar/WorkModal.tsx` + `.css`, `CalendarPage.tsx`, `src/base/pages/clients/ClientWorkspace.tsx` + `.css` + `ClientWorkspaceModern.css`, new `ClientBilling.tsx` + `.css`, `ContractsBoard.tsx`, `contractGroups.ts`, `clientsTypes.ts`, `useClientsData.ts`
- **DB (138, additive)**: `client_products.source_invoice_id`, `projects.source_invoice_id` (→ invoices, on delete set null) + indexes; index on `calendar_entries.project_id`. Shared table — Enterprise ignores the new columns.
- Invoices (not the automatic ones): a line with a product the client doesn't have yet (no active client_products row of it, not counting this invoice's own) opens a **contract** — client_products row (signed / starts on the issue date, price, quantity, recurring + period from the catalogue, `contract_ref` = invoice number, `source_invoice_id`); a line with a service they don't have yet opens a **project** (projects row, status open, kick-off = issue date). Done on save (draft or send) by `syncInvoiceOpens`; while a draft, a line taken off takes its contract / project with it, and deleting the draft removes them. The invoice window warns before saving ("Saving this opens 2 new things for X": Contract · product, Project · service) and the side says "Opens 1 contract and 1 project".
- Billing lists: a mini mark next to the number of an invoice that opened something, and an optional column **New contract** (Columns drawer / filter: a new contract · a new project · nothing new) in Invoiced and To invoice.
- Clients: invoice-opened products are a **contract of their own** (key `inv:<invoice id>`, "Contract · invoice N") in the pop-up's Contracts and in Clients › Contracts (`l:<client>|inv:<id>` for groups); no deal actions on it, "open" goes to the invoice. Projects opened by an invoice carry a "From an invoice" tag.
- Calendar: client work (billable or not) picks **which of the client's services** it was for (their open / on-hold projects, or General) → `calendar_entries.project_id`; the week shows the service on the entry. `isBilled` no longer counts non-billable / internal entries.
- Billing › Time: **By service** (client + service, General for the rest; split by person; the client as an optional column); the To-invoice lines from work are split per person *and* service ("Work · Ana · Implementation (…)").
- Client pop-up: new **Billing** tab (ClientBilling): figures (invoiced, paid, waiting / late, not invoiced yet ≈ at the client's rate), Coming up (drafts + logged-not-invoiced), Invoices (filter by state, mark when it opened something, opens it in Billing), Time by service (bars by person, folded rows with invoiced / to invoice / not billable and the entries).
- Projects tab: bug — the row carried the status as `is-open`, which the reveal CSS read as "expanded" (open projects came opened and wouldn't close): now `st-<status>`. Modern look: one white card per project, round chevron (lime on hover), details in a soft box.
- tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 22:30 · Enterprise · Reports: modern look + "New report" step by step
- files: `src/components/pages/sales/extras/SalesReport.tsx`, `src/components/pages/sales/extras/ReportsModern.css` (new), `src/components/framework/i18n/{en,es,de,nl}.json` (+45)
- Look: the page is in the modern style (title and pill buttons on the canvas, white 24px sheets, no hairlines, lime/ink accents); the report view's parts sit on the canvas; fixed the editor's "all / any / none" (and other light toggles) that were white on white.
- New report is now a guided flow (state `wiz`): Start (pick what each row is, or a ready-made report) → 1 Data (linked parts) → 2 Rows (period + filters) → 3 Columns → 4 Figures & charts (one-click suggestions) → 5 Name & save (name, who sees it, the report as it will read). A live preview (count + first rows) sits beside steps 1–4; "Open the full editor" is always one click away. A ready-made report jumps straight to step 5.
- The editor's panels (Data / Period / Filter / Columns / Charts) are now render functions (`dataBody()`…) shared by the editor and the steps — no behaviour change.
- tags: —
- deploy: written to the Mac; user to commit

### 2026-11-15 21:55 · Enterprise · Companies & Contacts: avatars no longer clipped; slimmer pop-up header; one section marker
- files: `src/components/pages/companies/CrmModern.css` (v4 block)
- List: the round avatars / logos were cut at the bottom (42px avatar in a 40px box inside a clipping cell) — box now 42px and the name cell doesn't clip (32px in compact).
- Pop-up (company and contact): the pine header is one row — avatar + name on the left, the detail tiles beside it (email / website give up room first, the rest never truncate), close on the right: ~85–92px instead of ~195px.
- Section index: only the sliding white pill marks the active section (the item's own rounded box was showing too, two shapes at once).
- tags: PORT? (Base companies/contacts drawers, if they use `dw-mod`)
- deploy: written to the Mac; user to commit

### 2026-11-15 21:55 · Base · Calendar header: icons on one line, "My calendar" compact + a new people picker
- files: `src/base/pages/calendar/CalendarPage.tsx`, `CalendarModern.css`
- The icon group (other calendars · bell · gear) sat at different heights: now every item is a 36px circle centred on one line.
- "My calendar": shows only the faces (+ chevron) and opens to "My calendar" / "You + N" on hover, focus or while open (no second line).
- Its pop-up rebuilt (`.cwp`): "Calendars on your week" + an N/3 pill (amber when full), a search field when there are more than 7 people, you pinned on top ("Always shown"), colleagues as rows with a round tick in their colour (the row tinted when on, dimmed when three are already on), "Only my calendar" to clear.
- No SQL. tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 21:40 · Base · Calendar: an Outlook / Google event logged as work goes through the step-by-step pop-up
- files: `src/base/pages/calendar/CalendarPage.tsx`, `WorkModal.tsx` + `.css`, `CalendarModern.css`
- "Log it as work" on an outside event used to open the full booking; now it opens WorkModal (new prop `source`: id, subject, outlook / google, account) with the event's day and time (rounded to 15 min) filled in. A card "From Outlook / Google Calendar · <title> · from–to" stays on top of every step; the choices are Client work (title as "what you did") or Something else (title as the entry's title) — no Shipment. Saved with `outlook_source_id` = the event's id (retried without it if the column is missing), so the event counts as logged and leaves the agenda as before. "Invite people or make it repeat? Open the full booking" still opens the old booking with the event (`logOutlookFull`).
- The event's card (OutlookCard) in the modern look: 24px white card, source chip as a pill (blue / red), round close, date as a pill, facts in a soft grey box with sentence-case labels, green pill "Log it as work".
- No SQL. tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 21:40 · Enterprise · Companies & Contacts: the list always fits the page — no sideways scroll, thin scrollbar
- files: `src/components/pages/companies/CompaniesPage.tsx`, `src/components/pages/contacts/ContactsPage.tsx` (scroller class `is-xscroll` → `is-fit`; grid tracks `minmax(0, <weight>fr)`, name column min 170px), `src/components/pages/companies/CrmModern.css` (v3 block)
- The lists never scroll sideways any more: however many columns are shown, they share the width in proportion to their usual size and long values end in "…" (header labels too). The vertical scrollbar is the thin grey one of the Clients page (8px, rounded #d5ddd9 thumb, no track).
- tags: PORT? (Base companies/contacts lists, if they use `is-xscroll`)
- deploy: written to the Mac; user to commit

### 2026-11-15 21:25 · Base · Calendar: the date picker (week / month title) fixed and in the modern look
- files: `src/base/pages/calendar/CalendarModern.css`
- Bug: the header rule that turns the nav's buttons ink (`.cv-nav :is(button, span)`) also hit the picker inside it, so today's day and the Today button were ink on ink (invisible). Now it skips `.cv-jump`.
- The picker itself: 24px white card, round arrows (lime on hover), sentence-case weekdays, round day cells, the picked week / month in mint, today a lime circle, "Today" a green pill, softer key hints.
- No SQL. Deploy: device, committed locally (user pushes).

### 2026-11-15 21:25 · Enterprise · Deals: the forecast's figures pickable like the list's; Board shows only the filtered stages
- files: `src/components/pages/sales/sales/DealKpis.tsx` (props `extra`, `prefKey`, `defaults`; `Def` / `KPI_ICO` exported; `DealKpisFixed` no longer used), `SalesPage.tsx`, `src/components/framework/i18n/{en,es,de,nl}.json` (+1)
- Forecast: its figure cards are the same component as List / Board (same size, same "choose the figures" button and per-card swap); the picker offers the forecast's own four (pipeline / weighted / next 90 days / overdue) first, then every deal figure; remembered in prefs `dealKpiSlotsForecast`, apart from the list's `dealKpiSlots`.
- Board: with a Stage filter, only those phases are drawn as columns (KanbanView `onlyPhases`); moving a card still uses every phase of the pipeline.
- deploy: written to the Mac; user to commit

### 2026-11-15 21:15 · Base · Calendar: Outlook / Google as one drop-down
- files: `src/base/pages/calendar/CalendarPage.tsx`, `CalendarModern.css`
- The two buttons side by side (Outlook, Google) are now one button in the header's icon group: the two logos (grey when off) + a chevron + the count of outside events shown. It opens "Other calendars": a row per source (logo, name, "N events in view" / Hidden / Not connected / Couldn't load) with its own switch (Outlook blue, Google red), "Connect" / "Fix" (opens the Outlook status card) or "Retry" when something's wrong, and a link to Settings › Calendar to choose calendars and accounts. Same on/off memory as before (per browser); only shows the sources allowed in settings. `toggleOl` removed.
- No SQL. tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 21:05 · Enterprise · New deal: pick several contacts in a row
- files: `src/components/pages/sales/sales/NewTracking.tsx`
- The search lists for contacts, team and products (Combo prop `multi`) stay open after each pick — what's picked leaves the list and shows above as a chip, the list follows the field down; clicking outside or Escape closes it.
- deploy: written to the Mac; user to commit

### 2026-11-15 20:30 · Base · Deals (overview + deal page) in Enterprise's modern look
- files: `src/base/pages/sales/sales/SalesPage.tsx`, `SalesPage.css`, new `DealKpis.tsx` + `DealKpis.css` + `SalesModern.css` (copied from Enterprise, `.dkp` classes), `src/base/pages/companies/CompaniesPage.tsx` (`FilterChips` + `hideField` / `extra`, old callers unchanged), `src/base/pages/sales/trackings/TrackingDetail.tsx`, new `trackings/DealModern.css` (copied from Enterprise), `src/base/framework/ActionsMenu.tsx` + `.css` (tone `red`)
- Overview (port of Enterprise 2026-11-14 21:20 / 21:45 / 2026-11-15 03:15): root `sl-mod`; the two stat cards (SoStatSel / SoStatWon, journeys, metrics, phase tiles) replaced by DealKpis — 1 to 6 cards each user picks (prefs.dealKpiSlots), status cards filter the list; Forecast's figures drawn with DealKpisFixed (Base: Open pipeline · Next 90 days · Overdue, no weighted). Board: count + pipeline tabs on one line (no "Pipeline is" chip). `DealsLook.css` (the dark hero) no longer imported by the page (file kept).
- Deal page (port of Enterprise 2026-11-15 03:40 / 04:30, look only): `.sl-dmod` — grey canvas, header in ink, four figure chips on the header's line (potential value · expected close date — Base shows the date, not a chance · days in the phase · owner + team), phase flow as a pine card with one figure ("of the way" in Base), white 24px cards, pill tabs; the trash button moved into Actions as a red "Delete this deal" (same confirmation).
- Not ported: the board's free placing / "Close gaps" (needs `pushDown` / `flowShown` in `src/base/pages/homepage/HomePage.tsx`, which has other uncommitted changes), contracts in the deal calculator, "Edit anyway" on won deals.
- No SQL. tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 20:20 · Enterprise · New deal step by step in the modern look; folded Activity centred
- files: `src/components/pages/sales/sales/NewTracking.tsx`, new `NewTracking.css`, `src/components/pages/sales/trackings/DealModern.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+26)
- New deal drawer (Deals › + New deal): same data and same create call, now four steps — Client (company, contacts with the company's own people as one-tap suggestions, optional deal name) → Pipeline (cards with phases / first phase, renewal / upsell tags) → Team (people, owner star, sales roles) → Products & details (products as tick cards, the deal fields, a "Ready to start" summary). Pine header card with the steps (done ones ticked in lime, each shows what was picked, click to go back; forward checks the steps in between), one step at a time as white cards, foot Cancel · Back · Next: … / Start tracking. Each step's check gives its message and jumps to the step that's missing something.
- Deal page: the Activity card folded is centred like the other folded cards (its open header's padding no longer applies), title in the same font.
- tags: PORT? (Base's new-deal drawer if it shares NewTracking)
- deploy: written to the Mac; user to commit

### 2026-11-15 11:20 · Enterprise · Companies & Contacts: the list in its own sheet, a structured pop-up header
- files: `src/components/pages/companies/CompaniesPage.tsx` (new `DwFact`, company pop-up header), `CrmModern.css`, `src/components/pages/contacts/ContactsPage.tsx` (contact pop-up header), `src/components/framework/i18n/{en,es,de,nl}.json` (+7)
- The user: hardly any difference between the header and the list, and the pop-up's header "dropped there without structure". List: now one white sheet (radius 26, shadow) under the header on the grey canvas — column headers its top strip with a line, rows inside separated by hairlines, grey on hover, lime ring when a company's people are open.
- Pop-up header: a pine card inset at the top (set apart from the grey sections below): lime avatar, eyebrow + what it is (Client / In sales / types as small pills), name, sub; under a thin line the details as labelled tiles (`DwFact`: Website, Email, Mobile, Telephone, Location, Language, LinkedIn, Contacts → goes to the section, "To fill in" in amber → goes to the missing fields).
- tags: PORT?
- deploy: written to the Mac; user to commit

### 2026-11-15 05:20 · Base · Calendar: notifications, "My time off" and the month view in the modern look
- files: `src/base/pages/calendar/InvitesTray.tsx` + `.css`, `CalendarSettingsModal.tsx` + `.css`, `CalendarPage.tsx`, `CalendarModern.css`
- Notifications (the bell, InvitesTray): grey canvas, light header with the bell in a mint circle + "N invitations waiting" / "You're all caught up" and a round close (the bottom "Close" is gone); an empty state; white 20px cards with the time as a pill, the organiser + what it is, "Nothing else booked" as a mint pill, Decline soft / Accept green pills; "Replies to yours" as one white card. The bell's count badge now matches the Outlook / Google badges (no dark ring, no pulse).
- The gear ("My time off", CalendarSettingsModal `requestOnly` → class `cws-mod`, so Settings › Calendar and Management keep theirs): 660px, light header with an icon, grey canvas, white 24px cards; allowance figures in one card with "Left" in mint; Holiday / Sick leave / Personal as a pill switch; green pill "Request time off"; requests as one card. For bosses the link to Settings › Calendar now works (CalendarPage passes `onOpenSetup` → /settings, view calendarpage).
- Month view: sentence-case weekday header, light hairlines, round day numbers (today lime), airy cells, chips 22px tinted by colour, cutoff flag as a small red circle, "+" as a green round button on hover; the day's "Nd" pill only when there's billable time (no more "0d" everywhere), amber when under target.
- No SQL. tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 04:55 · Enterprise · Companies & Contacts in the modern look (header, list, side pop-up)
- files: new `src/components/pages/companies/CrmModern.css`, `CompaniesPage.tsx` and `src/components/pages/contacts/ContactsPage.tsx` (classes `co-mod` / `ct-mod` on the pages, `dw-mod` on their side pop-ups, the CSS import) — no behaviour change
- Header: the dark-green header card is gone; the same header as Deals / Clients — title in ink on the grey canvas, search / Filters / Views / the count as 44px white pills, Actions a pine circle with lime dots. List: each row a white pill without outline (lime ring on hover and when a company's people are open), column headers as plain text on the canvas, avatars in circles (companies mint, people pine), Client / In sales / types as soft pills; a company's opened people as a white card.
- Side pop-up (company and contact): same structure and sections; no dark header band — pine avatar, name in ink, details as white pills; sections index as pills with the open one in pine; sections white 24px cards with icons in circles; fields soft grey without outline (lime ring when typing); pill buttons, Save in green. Other pop-ups that use `.dw` (new deal, deal fields, sales roles) are unchanged.
- tags: PORT? (Base's Companies / Contacts if it uses the same pages)
- deploy: written to the Mac; user to commit

### 2026-11-15 04:50 · Base · Calendar: step-by-step entry pop-up (billable or not) + "Who sees whom" as two lists
- files: `src/base/pages/calendar/WorkModal.tsx` + `.css` (rebuilt), new `src/base/pages/calendar/CalendarAccess.tsx` + `.css`, `src/base/pages/calendar/CalendarPage.tsx`, `CalendarModern.css`, `src/base/framework/pageAccess.tsx`, `src/base/pages/settings/PageAccessModal.tsx`, `src/base/pages/settings/SettingsPage.tsx`
- Entry pop-up (WorkModal) is now a guided flow with a numbered stepper: Client work = What → Client (search, logos, your teams first, picking one moves on) → Time (big hours figure, day/from/to, 30 min…8 h chips) → Billing (Billable / Not billable cards, what you did, recap). Shipment = What → Client → Product (− / + quantity, price, total) → Send (day, notes, "make the invoice now", recap). Something else = What → Details. Enter = next, editing opens on the last step (steps clickable). Modern look: grey canvas, light header, white 24px cards, pills, Next green; shipments indigo, other slate, not billable amber.
- **Not billable client work**: kind `client_nonbillable`, billable 0, client set. Billing never picks it up (its queries use kind in client_work/shipment). The calendar opens it in the same pop-up and shows an amber "Not billed" tag instead of the hours; it doesn't add to "on clients". **PORT?** for Enterprise if they want the same.
- Settings › Calendar › Who sees whom: two lists — "Only their own calendar" / "Sees other people's calendars". Move with the arrow or drag across. For someone who sees others: whose (Everyone / Their department / Chosen people with chips + add) and how much (Read entries / Only busy times); "Follow their role again" drops their own rule. Bosses shown as "see everything". The old editor by security role / department stays under "By security role and department".
- Rules: `CalViewRule` gets `see: "picked"` + `ids?: string[]` (JSON in page_data_scopes "calendar_view", no SQL); `canSeeCalendar` handles it; the old editor keeps `ids` when changing detail and lists "Chosen people".
- No SQL. tsc clean. Deploy: device, committed locally (user pushes).

### 2026-11-15 04:30 · Enterprise · Deal page: one percentage, Delete in Actions, the calculators in the modern look
- files: `src/components/pages/sales/trackings/TrackingDetail.tsx`, `trackings/DealModern.css`, `src/components/framework/ActionsMenu.tsx` + `.css` (tone `red`), `src/components/framework/LineCalcModal.css` (v2 block), `src/components/pages/sales/extras/ContractTerms.css` (`.ctm` block), `src/components/framework/i18n/{en,es,de,nl}.json` (+5)
- The phase flow showed two figures (e.g. 29% progress and "20% close"). Now one: the close chance the pipeline gives the current phase (Settings › Pipelines, `close_probability`; won 100 / lost 0), labelled "close"; only when the phase has none, how far along the phases it is (`trackingPct`), labelled "of the way". The tall bar no longer repeats it.
- Delete: the header's trash button is gone; "Delete this deal" is the last item of the Actions menu (group "Deal", new red tone in ActionsMenu), same confirmation.
- Calculators: LineCalcModal (product / service — also used by Clients and the handoff) and the contract modal (ContractModal) in the modern look: grey canvas, white 22px cards without outlines or side stripes, icons in circles, lime for the picked tier and finished steps, the result / total a pine card lit with lime, lime Apply button, pill buttons. The contract templates editor and the contract view keep their look (scoped to `.ctm`).
- tags: PORT? (Base's calculators / ActionsMenu if it shares them)
- deploy: written to the Mac; user to commit

### 2026-11-15 04:10 · Base · Calendar: Outlook + Google side by side, each with its own switch and colour, modern look
- files: `src/base/api/googleCalendar.ts` (new), `src/base/api/connectedAccounts.ts` (+`accountToken(id)` — the deployed `connected-accounts` `token` action), `src/base/api/outlookSync.ts` (`OutlookEvent` + `src?: "google"`, `account?`), `src/base/pages/calendar/CalendarPage.tsx`, new `src/base/pages/calendar/CalendarModern.css`
- Google Calendar is read straight from the browser (`calendars/primary/events`, singleEvents, paged, 3-min cache) with each connected Google account's fresh token; events map to `OutlookEvent` with id `g:<id>` so they go through the same not-logged / cards / month-chip paths. Follows Settings › Calendar › My calendars (`prefs.calendarSources`: google / microsoft / hidden accounts).
- Header: the old Outlook show/hide button is now two switches — Outlook (blue `#0f6cbd`) and Google (red `#d93025`), each with its count badge; on/off is remembered per browser (`cal.google` next to the Outlook key). Each button only shows when that source is on in settings and has an account. Outside events, tags, month chips and the event card are tinted by source and say where they come from (+ account).
- Look (`.cal-mod`, scoped): grey canvas, light header with white pills, green view slider, pine To-do button, week grid and month as white 24px cards with soft shadow, lime today, title fix.
- No DB / no SQL. tsc: no new errors. Deploy: device, committed locally (user pushes).

### 2026-11-15 03:40 · Enterprise · Deal page: cards go where you put them + the modern look
- files: `src/components/pages/homepage/HomePage.tsx` (HomeBoard: kit option `free`, new `pushDown` / `placeAt` / `sizeAt` / `flowShown`), `src/components/pages/sales/trackings/TrackingDetail.tsx`, new `trackings/DealModern.css`, `src/components/pages/sales/sales/DealKpis.tsx` + `DealKpis.css` (classes renamed), `src/components/framework/i18n/{en,es,de,nl}.json` (+17)
- Bug (the user couldn't put cards where he wanted, even in free gaps): two causes. (1) Class clash — the deal board's cards are `.dk-card` inside `.dk`, the same names as the Deals overview figures (DealKpis.css: `.dk-card { position: relative … }`), so depending on CSS order the cards lost their absolute position and stacked. DealKpis now uses `.dkp` / `.dkp-card` (nothing else used them). (2) The board engine had gravity (every card falls up, drops reorder like a list). The deal board now places freely (`DEAL_KIT.free`): a card stays exactly where it's dropped (gaps allowed), whatever it lands on moves down; resizing pushes down too. In view mode, cards fitted to their content / folded only close the room they freed (`flowShown`), the gaps the person left stay. Dock: new "Close gaps" (everything up). The home page keeps its gravity (no `free`).
- Look (`.sl-dmod`, same everything inside): grey canvas instead of the pine band with aurora; header in ink with a pine badge, lime status chip, white round buttons, pine Actions button with lime dots; on the header's line four figure chips (potential value — pine, close chance + date — green, days in the phase, owner + team), each opens its card / the team menu (under 1360px they take their own row); the phase flow is a pine card lit with lime (gold when won); cards white, 24px corners, soft shadow, icons in circles, softer inner boxes, pill tabs.
- tags: PORT? (Base's deal page / board if it shares `.dk-card` with its KPIs)
- deploy: written to the Mac; user to commit

### 2026-11-15 03:15 · Enterprise · Deals › Board: the count and the pipeline tabs on one line
- files: `src/components/pages/companies/CompaniesPage.tsx` (`FilterChips` props `hideField`, `extra`), `src/components/pages/sales/sales/SalesPage.tsx`, `SalesPage.css`
- The board had two rows doing the same job: "N of M deals" + a "Pipeline is X" chip, and under it the pipeline tabs. Now one line: the count, then the pipeline tabs; the board's own pipeline no longer shows as a chip (only when several pipelines were picked in Filters does that chip stay, as it limits the tabs). "Clear filters" keeps the board's pipeline.
- `FilterChips` (shared by Companies / Contacts / Deals lists): two optional props, old callers unchanged.
- tags: PORT? (Base's Deals board, if it has the same two rows)
- deploy: written to the Mac; user to commit

### 2026-11-15 · Base — "My calendars" moved to Settings › Calendar
- The Google Calendar / Outlook / Both choice is no longer in Integrations (`Integrations.tsx` / `IntegrationsModern.css` back as they were): it's the first section of Settings › Calendar, "My calendars" (new `calendar/CalendarSources.tsx/.css`, prefix `.csrc-`): three cards (Google Calendar · Outlook · Both, with how many accounts each; not connected → greyed) and with several accounts a switch per account. Same `profiles.prefs.calendarSources` (`api/calendarSources.ts`). No SQL.

### 2026-11-15 03:05 · Enterprise · Whose mail: the lists decide for Bosses too (SQL 141)
- files: `sql/141_mail_boss_follows_lists.sql` (new, applied), `src/components/pages/settings/MailAccess.tsx`, `MailAccess.css`, `src/components/framework/i18n/{en,es,de,nl}.json` (+2)
- The user: "lo que manda es esta cajita, da igual si es Boss". `mail_can_see()`: a Boss with their own line in 'mail_view' `users[id]` now follows it (own / own + picked / all); a Boss nobody moved still reads everything; platform superadmins still read all. The page lets Bosses be dragged like anyone (they keep a "Boss" tag).
- tags: DB
- deploy: SQL 141 applied in Supabase 2026-11-15; files written to the Mac; user to commit

### 2026-11-15 · Base — Settings › Integrations: "Your calendar" — Google Calendar, Outlook or both
- New `src/base/api/calendarSources.ts`: per person, `profiles.prefs.calendarSources = { google, microsoft, hidden: ["<provider>:<account id | primary>"] }`; `useCalendarSources()` (a change in Settings reaches an open Calendar at once), `calendarShown()`.
- `Integrations.tsx` (`CalendarChoice`): a card under the header when a calendar is connected — Google Calendar / Outlook / Both, and with several accounts a switch per account. `IntegrationsModern.css` follows.
- `CalendarPage.tsx`: Outlook off there → its events and the Outlook button are hidden. Showing Google Calendar events in the Calendar is the next step (not built yet). No SQL.

### 2026-11-15 02:55 · Enterprise · Settings › Tickets › Whose mail: three lists, drag and drop
- files: `src/components/pages/settings/MailAccess.tsx`, `MailAccess.css`, `SettingsPage.tsx`, `src/components/framework/i18n/{en,es,de,nl}.json` (+14 strings)
- The user found the department / role / person rules too complex. Whose mail is now three lists — Only their own · Theirs + some colleagues · Everyone's — and people are dragged between them (HTML5 drag and drop, drop zones light up). In the middle list each person has a multi-select (framework `MultiSelect`, searchable) of the colleagues whose mail they also read, shown as name chips. Bosses sit locked in Everyone's.
- Each move saves a per-person rule in page_data_scopes 'mail_view' `users[id]`: own → `{see:"own"}`, middle → `{see:"people", people:[…]}`, everyone's → `{see:"all"}` (SQL 140's `mail_can_see` already handles all three — no SQL). People nobody moved yet sit where the older role / department / Everyone / default rules put them (tag "Default" / the department or role); a reset button puts a moved person back on the default. The old rules stay in the data but aren't edited from this page anymore. The "who reads what" side card is no longer used here (SettingsShell `top` keeps the one-line header).
- tags: none
- deploy: written to the Mac; user to commit

### 2026-11-15 · Base — Billing › Time: the month is a calendar button next to Actions
- `BillingPage.tsx` (`MonthPick`): the month pill in the toolbar is gone; a calendar button sits in the header next to Actions (as Clients' "as of" day). It opens a year / month grid (no future months); another month shows on the button in lime ("Oct 2026") with an × back to this month. `BillingModern.css` follows.

### 2026-11-15 · Base — Billing › Time rebuilt like the other two views
- `BillingPage.tsx`: Time is a list now, the same as Invoiced / To invoice — your figures on top (`billingTimeKpis` / `billingUnitsKpis`: hours or units, not invoiced, value, % invoiced, people, clients, busiest client, per day), a toolbar with the month pill (‹ November 2026 › / This month), By person · By client · By product (units) and Hours | Units, then the list: every column filters / sorts from its header, search + Filters / Views in the header, columns yours (`billingTimeColumns`: split bar, hours / units, not invoiced, invoiced, % invoiced, value, days, per day, clients / people). A row opens its month (the Time pop-up). The old two cards (By person / By client) are gone.
- `BillingModern.css` follows. No SQL.

### 2026-11-15 02:40 · Enterprise · Settings › Tickets: the index back on the left, "who reads what" as a third column
- files: `src/components/pages/companies/CompaniesPage.tsx` (`SettingsShell top`), `src/components/pages/settings/SettingsModern.css`
- `SettingsShell top` now keeps the usual left index (like every settings page); only the header is one line (‹ Settings, badge, title, the hero — Tickets' KPI chips — on the right). The side card is a third column right of the sections card: the middle card grows to its full width (up to 1060px) first, the side card takes the rest (at least 290px), and only while a section uses it.
- Whose mail: clicking a department / role / person shows "who reads what" in that card, outside the Whose mail card (company overview when nothing is picked).
- tags: PORT?
- deploy: written to the Mac; user to commit

### 2026-11-15 02:25 · Enterprise · Settings › Tickets: one header line + "who reads what" as a side card
- files: `src/components/pages/companies/CompaniesPage.tsx` (`SettingsShell` prop `top`), new `src/components/pages/settings/settingsAside.ts` (context + `useSettingsAside()`), `MailAccess.tsx`, `MailAccess.css`, `SettingsModern.css`, `SettingsPage.tsx`
- `SettingsShell top`: one header line — ‹ Settings, badge, title, the sections as pills (with the sliding ink) and a fold button, then the hero on the right (Tickets' four KPIs as chips; under 1400px without icons so it still fits on one line at 1280). No left index column: the sections keep their width (up to 1060px) and a side card column appears on the right only while a section uses it (`useSettingsAside()` portals into it). Pages without `top` are unchanged.
- Whose mail's "who reads what" panel now lives in that side card (company overview, or the picked department / role / person), instead of squeezing the list.
- tags: PORT? (SettingsShell `top` / side card could serve Base's settings pages too)
- deploy: written to the Mac; user to commit

### 2026-11-15 · Base — Billing shows the clients' logos
- New `billing/ClientLogo.tsx` (CompanyLogo: the website's icon, else the initial on mint). `billingApi.ts`: `BClient.website` = the linked company's `website`, else the domain of the billing e-mail (free-mail domains skipped, `mailDomain`).
- Logos in the Invoiced and To invoice lists, Time › By client (with its colour dot), the Time pop-up (a client's header, a person's split by client), the invoice pop-up (header and Bill to card) and the XML export list. No SQL.

### 2026-11-15 · Base — Billing pop-ups in the modern look; one soft shadow on every figure card
- New `billing/BillingModals.css` (imported in `BillingPage.tsx`): the invoice, "When invoices are made" and XML export pop-ups get a light header (ink title, mint icon, round grey close), grey canvas with white 20–24px cards, sentence-case labels, soft rounded fields, pill buttons with the main one in Next green (lime icon), the total as the pine card. "When invoices are made" now sizes to its content (no empty band at the bottom).
- Time: clicking a person or a client opens a pop-up with their month — figures, split by client / person, and day by day (each entry tagged Invoiced / To bill); works for Hours and Units. Replaces the inline unfold.
- Figure cards: one soft shadow for all of them (the pine / green ones had a big coloured glow that ran into the list's header and got cut) — Billing (`BillingModern.css`) and Clients (`ClientsModern.css`).

### 2026-11-15 02:10 · Enterprise · Settings › Tickets: back to the rh150 look; Whose mail in two parts
- files: `src/components/pages/settings/MailAccess.tsx`, `MailAccess.css`, `SettingsModern.css`, `SettingsPage.tsx`, `src/components/framework/i18n/{en,es,de,nl}.json` (+38 strings)
- The user didn't like the compact all-white version (02:30 entry below): Settings › Tickets is the rh150 look again (title + subtitle, four figure cards, narrower column).
- Whose mail: two parts — the rules on the left (pick any department / role / person line: the whole header is the button, an arrow points at the panel), and on the right a sticky "who reads what" panel: with nothing picked, the whole company in three groups (read everything / colleagues' mail too / only their own) with a bar; with a line picked, each person animates in with what they read in words ("Reads the Sales department"), how much (n of N people's mail, a meter), whose, where the rule comes from, and "Set something else for …" to give them their own rule. People tab rows show Everything / Colleagues too / Own only. Narrow (container < 780px): one column, panel only when something is picked.
- tags: PORT? (Base has no Tickets settings)
- deploy: written to the Mac; user to commit

### 2026-11-15 · Base — Billing reworked: Orbit's header, header filters, your columns and figures, one To invoice list, units
- `BillingPage.tsx`: no "Billing" title; the header is Orbit's row — view switch (icons, names on hover, To invoice counter), search, Filters / Views, … Auto pill, Actions (New invoice, Export XML, Columns, Automatic invoices).
- Invoiced: the four status cards and the status chips are gone — every column filters / sorts from its header (ColumnHead), saved views; columns picked and ordered (Actions › Columns, `profiles.prefs.billingInvColumns`); month groups replaced by the header sort.
- To invoice: proposed drafts and work / shipments not invoiced are ONE list, told apart by a Stage tag (Proposed · automatic / Proposed · manual / To bill), with the stage tabs on top; header filters, own columns (`billingToColumns`); click a draft to review, a To bill row to create its invoice.
- Figures on top for both, yours to pick (up to 6, `billingInvKpis` / `billingToKpis`), first pine, second green, rest white; they follow the list's filters. The old To invoice hero is gone.
- Time: Hours / Units toggle — units shipped (shipments in the Calendar) per person, per client and per product.
- Scroll: the page is fixed (header + figures), only the list scrolls under its sticky column labels, as Orbit / Clients.
- `BillingModern.css` follows. No SQL.

### 2026-11-15 02:30 · Enterprise · Settings › Tickets: compact, KPIs in the header
- files: `src/components/pages/settings/SettingsModern.css`, `MailAccess.tsx`, `MailAccess.css`, `SettingsPage.tsx`, `src/components/framework/i18n/{en,es,de,nl}.json` (+25 strings)
- One header line: ‹ Settings, badge, "Tickets" and the four KPIs as chips on the right (they wrap to their own row under 1200px); no subtitle; full width, 186px index, tighter cards.
- "Clients' mail only": the lead paragraph became one line of fact chips (the long explanation is their tooltip); options with short texts.
- "Whose mail": a one-line tip instead of the lead; every department / role / person rule is one row ([+ Also] [rule] [Shared] [People ›]), chips only when there are any; boss roles read "Boss — reads everything"; on ≥1700px the lists (and Security's) go in two columns.
- tags: PORT? (Base has no Tickets settings — only if it adopts them)
- deploy: written to the Mac; user to commit

### 2026-11-15 · Base — Billing in the modern look, a bit lighter
- New `billing/BillingModern.css` (scoped `.bz.bm`, imported in `BillingPage.tsx`): grey canvas, no dark header band — title, white pill switch (green pill for the view you're on, lime counter), pill search / Auto / pine "New invoice". The four figures as Clients: Waiting = pine card, Paid this month = green card, Overdue / Invoiced white. Filter chips and Export XML as white pills (no black), column labels plain on the grey page, each month one white card, To invoice hero / cards / Time in white 24px cards, "Create invoice" in green. Modals unchanged.
- Lighter: invoice / work grouping by push instead of copying arrays (was O(n²)), people looked up in a Map, rows off screen skipped (`content-visibility: auto`).

### 2026-11-15 · Base — Orbit: no Contracts view in Base; Clients without the second flicker
- `orbitTypes.ts`: `ORBIT_VIEWS` = All · Contacts · Companies · Clients. Contracts is Enterprise only; in Base a client's contracts are read in its pop-up (ClientWorkspace). Old `?view=contracts` links land on Clients. The type keeps "contracts" (the shared Clients page still has `mode="contracts"`).
- `OrbitPage.tsx`: no background mount of Contracts (it mounted a second Clients page ~2.4s after opening Orbit — the "second load" flicker when you went to Clients).
- `ClientsPage.tsx`: no "Open in Contracts" from a client's pop-up in Orbit; no longer reads Orbit's context.
- `OrbitModern.css`: once settled, rows / cards keep still (no page entrance replay).

### 2026-11-15 01:45 · Enterprise · Settings › Tickets in the modern look
- files: `src/components/pages/companies/CompaniesPage.tsx` (`SettingsShell` takes `className` and `hero`), `src/components/pages/settings/SettingsModern.css` (the `.sx-mod` look), `MailAccess.tsx` (`TicketsFigures`), `SettingsPage.tsx`, `framework/i18n/*.json`
- Settings › Tickets: grey canvas, ink title, pine badge, four figure cards (mail that comes in, clients, mailboxes, mail rules — pine, green, white), pill index, 24px borderless cards, the Security and mail sections as soft pill rows. Only pages that pass `className="sx-mod"` change, so the other settings pages stay as they are until they're done the same way.
- tags: PORT? (Base's SettingsShell copy could take the same `className` / `hero` and `.sx-mod` rules)
- deploy: written to the Mac / user to commit

### 2026-11-15 · Base — Orbit: one column-header style, the list comes down like a blind
- `OrbitModern.css`: All / Contacts / Companies headers now look like Clients / Contracts — plain labels on the grey page (sentence case, 12.5px, grey), no white strip; the list is one white card with four round corners.
- Switching views, every list (All, Contacts, Companies, Clients cards / table, Contracts cards / table) unfolds row by row from its top edge (rotateX, 24ms stagger, first 16 in order) — the same in all five.
- `OrbitPage.tsx`: `.is-settled` on the view 1.1s after a switch, so rows that load later (scrolling, next block) don't animate. `.is-in` stays (removing it would replay the pages' own first entrance).

### 2026-11-15 01:30 · Enterprise · Whose mail: every department and role, people below them, a per-person preview (SQL 140)
- files: `src/components/pages/settings/MailAccess.tsx` / `.css` (the "Whose mail" section rebuilt), `SettingsPage.tsx` (hint), `framework/i18n/*.json`; new `sql/140_mail_view_reports.sql`
- Now lists **every** department and **every** security role (before: only those with non-boss people), plus a People tab. Each line: its rule (or "No rule — follow …"), Shared mailboxes on/off, "Also" people, and for "Departments you pick" the teams. **People ›** opens a panel on the right: each person of that department / role, which rule reaches them (own / role / department / Everyone / default / Boss), whose mail they read (avatars) and their own override; a person's Detail also shows who reads theirs.
- New scope **"Theirs + the people below them"** (profiles.manager_id, all levels down). "Also" people add to any scope (old "people" scope = own + picks, still read).
- SQL **140** (applied 2026-11-15 with the user's OK): `mail_can_see()` with the scope `reports` (recursive on manager_id) and picked people added to any scope.
- tags: DB
- deploy: written to the Mac; SQL 140 applied / user to commit

### 2026-11-15 · Base — Orbit: the tab switch closes smoothly
- `orbitContext.ts`: the switch's open / closed state moved out of React context into a tiny store (`useNavOpen` / `setNavOpen`, useSyncExternalStore). Before, every hover in / out re-rendered Orbit and the Clients + Contracts pages (they read the context) right as the animation started — that's what made it stutter. Now only the switches re-render. `OrbitPage.tsx` / `OrbitSwitch.tsx` follow.
- `Orbit.css` / `OrbitModern.css`: open on `:has(:focus-visible)` instead of `:focus-within` — after a click the tab kept focus and the switch stayed open after the pointer left.

### 2026-11-15 00:30 · Enterprise · E-mail: clients' mail only + who reads whose (SQL 139) · Base gets the billing mirror · SQL 136 applied
- files: new `sql/139_mail_clients_only.sql`; new `src/components/pages/settings/MailAccess.tsx` / `.css`; `src/components/pages/settings/SettingsPage.tsx` (Settings › Tickets is now its own page: "Clients' mail only", "Whose mail", then the Security section); `framework/i18n/*.json`.
- **Base files written by the Enterprise chat, on the user's explicit request** (md5-checked, Base's versions were unchanged since Enterprise copied them): `src/base/pages/settings/AccountSettings.tsx` / `.css` = Enterprise's billing mirror (owner-only company part, "Next updated your billing", New marks, Changes list, live), with Base import paths; new `src/base/api/billingApi.ts` (Base copy of `src/components/api/billingApi.ts`, imports only the kernel's `supabase`); `src/base/pages/homepage/HomePage.tsx` — the bell knows `billing_next` (Next, receipt icon, a Billing tab, opens Settings › Your account). Base chat: keep these, don't revert; port further changes from Enterprise's files.
- Clients' mail only (DB): `mail_is_client()` — a client's contact list address, the client company's e-mail / website domain / contacts and their domains, client mail rules (address or @domain); public domains only by exact address, own company domain never. `mail_row_allowed()` (outgoing: any recipient a client) replaces the CRM check in the sync trigger (`mail_keep_known`, nothing else is stored), in the restrictive read policy `mail_known_only` (old stored mail is hidden, not deleted) and in `ticket_mail_known` (tickets made from mail). On today's data: 272 stored → 47 visible (was 208). Setting `keep` = clients (default) | crm in `page_data_scopes` page `mail_view`.
- Who reads whose (DB): `mail_can_see()` + restrictive policy `mail_whose` on `ticket_mail_messages`, by mailbox owner: person › security role › department › everyone → own / people (picked) / department / teams (picked departments) / all, + shared mailboxes on/off; always their own mailbox and the mail of tickets assigned to them; boss / superadmin all. Nothing saved: managers their department, the rest their own.
- SQL 136 (contract groups) applied 2026-11-14 with the user's OK. SQL 139 applied 2026-11-15 00:59 with the user's OK: the database now keeps and shows only clients' mail (47 of 272 stored) and applies who-reads-whose.
- tags: DB / PORT? (Base has no Tickets page; the DB rules apply to Base companies too — any mail they sync is clients-only)
- deploy: written to the Mac; SQL 136 and 139 applied / user to commit

### 2026-11-14 · Base — Orbit: switching views no longer looks like a page reload
- `OrbitModern.css`: the header row swaps in place (no fade / scale; the old one hidden at once); the content cross-fades (old fades out 0.2s while the new fades in 0.3s, 4px lift, nothing sideways) — never a blank page in between. Clients / Contracts pages are see-through inside Orbit (the stage has the same grey), so the old figure cards turn edge-on under the new ones.
- `OrbitPage.tsx`: Contracts is mounted in the background too (2.4s after opening Orbit), so clicking it never shows "Loading the contracts…" and its cards don't turn twice.

### 2026-11-14 23:40 · Enterprise · Platform console in the modern look + company billing on both sides (SQL 138)
- files: new `src/components/api/billingApi.ts` (shared: load / save entities & invoices, change history, seen marks, live watch, words); new `pages/superadmin/SuperAdminBilling.tsx` / `.css` (a company › **Billing** tab); new `pages/superadmin/SuperAdminModern.css`; `SuperAdminHome.tsx` (Shell gets `sa-mod`, a lime dot on Companies when companies changed their billing, a "Billing updated" chip in the list that opens the Billing tab), `SuperAdminClient.tsx` (Billing tab with a "new" count); `pages/settings/AccountSettings.tsx` / `.css`; `SettingsPage.tsx` ("N billing updates" on the Your account card); `pages/homepage/HomePage.tsx` (notification kind `billing_next` → Settings › Your account, "Billing" tab in the bell); `framework/i18n/*.json`; new `sql/138_tenant_billing_events.sql`
- Console look: grey canvas, title + pill tools instead of the dark header block, figures as cards (pine, green, then white), 24px borderless cards, tables with pill rows, the company header as a white card with pill tabs, pill buttons / segments / search, rounder dialogs. Only under `.sa.sa-mod`.
- Billing tab (Next): who the company is billed as (add / edit / remove / star the default — the same rows the owner edits), every invoice (new / edit / delete, status in place; the dialog works out users × price/month × months − discount + VAT and snapshots the billed-to entity; next number NX-<year>-####), figures (billed as, paid, outstanding, last invoice), and the change history of both sides. What the company changed since you last looked is on top and marked "Updated by them".
- Your account (company side): the company part is now the **owner's only (role boss)** — org superadmins no longer see it in Enterprise. What Next changed since the owner's last visit is on top ("Next updated your billing"), marked New in the lists, plus a Changes list of both sides. Both sides follow each other live (realtime + focus + 2 min).
- SQL **138** (applied 2026-11-14): `tenant_billing_events` (side client/next, actor, kind entity_added/changed/removed/default, invoice_added/changed/removed, ref, label, fields) written by triggers on both SQL 137 tables (the other entities losing their star are not logged); `tenant_billing_seen` (per person per company); Next's changes push a `user_alerts` row `billing_next` to the company's bosses; the three tables in `supabase_realtime`. RLS: read = the company's billing manager (137's `tenant_billing_manager()`) or a superadmin.
- §8: Base's request "issue CRM invoices to companies (SuperAdmin)" — done.
- tags: DB / PORT? — Base: `src/base/pages/settings/AccountSettings.tsx` could take the same mirror (copy Enterprise's file: owner-only + news + Changes, using `src/components/api/billingApi.ts`), and Base's Home bell could learn `billing_next` (ref_type `billing` → Settings › Your account). Until then a Base owner still gets the alert (generic look).
- NOTE for the Base chat: your write of this file at ~23:00 dropped 13 Enterprise entries of today (16:50 → 22:50) and §7's "138"; restored here. Please merge, never replace the file.
- deploy: written to the Mac; SQL 138 applied in Supabase / user to commit

### 2026-11-14 22:50 · Enterprise · Settings › Interface = Base's page (+ Enterprise's Outlook card)
- files: new `src/components/pages/settings/InterfaceSettings.tsx` / `.css` (copied from `src/base/pages/settings/`; imports to Enterprise paths, plus a `children` slot under the left column), `SettingsPage.tsx`, `framework/dockPrefs.ts`, `framework/i18n/*.json`
- The old inline Interface block and its state (small icons, toolbar order, drag) left SettingsPage; `<InterfaceSettings uid canSee onBack>` renders the page. Enterprise keeps Outlook calendar sync here (Base has it under Integrations) as an `.ifs-card.is-outlook` passed as children.
- `dockPrefs.ts` now exports `DOCK_COMPACT_KEY` / `DOCK_COMPACT_EVENT` (same values); SettingsPage re-exports them so AppLayout's import keeps working.
- tags: PORT? none (port from Base)
- deploy: written to the Mac / user to commit

### 2026-11-14 22:20 · Enterprise · Settings: Base's landing redesign + Base's "Your account" page (you + your company billing)
- files: `src/components/pages/settings/SettingsPage.tsx`, new `SettingsModern.css`, new `AccountSettings.tsx` / `AccountSettings.css` (both copied from `src/base/pages/settings/`, only the imports changed to `../../api/supabase` and `../../login/LoginPage`), `framework/i18n/*.json`
- Landing: same look as Base v71–v74 (`.sty-*` rules only; the inner `.st` settings pages are untouched). Groups now carry `is-${g.k}`. Enterprise has six company cards and two of yours, so the company side takes 3 columns and "Just you" 1 (same card width, both stacks end level); one column under 1250px.
- Your account: the old password / sign-out block is gone; `<AccountSettings onBack…/>` from Base renders it (your details, password, sign out, and for the boss / org superadmin the company plan, billing entities and billing history from SQL 137). "Your account" card sub: "You, your password and your company".
- §7: Base used 137 → next free is **138**. §8 SuperAdmin invoice issuing: noted, not started yet (waiting for the user).
- tags: PORT? (none needed — this is a port from Base; keep `AccountSettings` in step if Base changes it)
- deploy: written to the Mac / user to commit

### 2026-11-14 21:45 · Enterprise · Deals: livelier figures and view switch, board v2, forecast controls stay put, no page title
- files: src/components/pages/sales/sales/{DealKpis.tsx,DealKpis.css,SalesModern.css}, src/components/framework/i18n/*.json
- Figures: numbers count up to new values; on hover a light follows the pointer, the card lifts, the icon pops (white cards: it turns green), the bar shines; a press gives way; the card filtering the list breathes a lime ring and shows a "Filtering" tag.
- List / Board / Forecast: the green pill springs between views with a soft sheen, the others tint and their icons hop on hover; the active icon lime. Filters / actions lift on hover.
- Deals title hidden (kept for screen readers) — the menu says where you are; the search takes its place.
- Forecast: the By day / By month and Weighted / Full value bar is sticky at the top of the timeline (green pills), with a fade under it.
- Board v2: columns as soft trays with a dot, a white count pill and what's in play; Won tinted lime, Lost soft coral (round marks); dropping: lime outline and the tray lifts (coral on Lost); cards without the left accent, round avatars, status pills, lift + glow on hover, lime when ticked.
- Checked: dragging a deal onto a Lost column already asks why (LossReasonModal, the same as on the deal) — moveTrackingToPhase → setLossAsk.
- deploy: written to the Mac; user to commit

### 2026-11-14 21:20 · Enterprise · Deals in the modern look + figures on top that each user chooses
- files: src/components/pages/sales/sales/{SalesPage.tsx,DealKpis.tsx (new),DealKpis.css (new),SalesModern.css (new)}, src/components/framework/i18n/*.json
- Figures: the two fixed stat cards (Total + Won, with the stage tiles when won didn't matter) are replaced by DealKpis — 1 to 6 cards the user picks from 12 (Deals, Open pipeline, Won, Win rate, Weighted pipeline, Closing in 90 days, Overdue, Average deal, New this month, Won this month, Lost, On hold), saved in profiles.prefs.dealKpiSlots (default Deals · Open pipeline · Won · Win rate). They follow every filter; Won / Lost / On hold / Open pipeline filter the list on click (Deals clears the status); ⇄ on a card changes or removes it; the tile on the right opens the picker. Forecast keeps its own four figures, drawn with the same cards (DealKpisFixed). Removed: SoStatShell/SoStatSel/SoStatWon/SoKpi, the journeys memo, metrics, wonMatters, phasePick (the stage tiles of the wide card) — stage filtering stays in Filters / column headers.
- Look (SalesModern.css, root gets `sl-mod`): no dark header band — title on the canvas, search / filters / views / List·Board·Forecast as 44px pills (open view green), actions launcher pine; list rows as white pills with a lime hover ring and the header on the canvas colour; board columns soft grey with white cards, pipeline picker as pills; forecast segmented controls as pills and borderless cards.
- tags: PORT? (src/base sales page if Base wants it)
- deploy: written to the Mac; user to commit

### 2026-11-14 20:40 · Enterprise · Clients / Contracts / Projects: figure cards at a middle size
- files: src/components/pages/clients/ClientsModern.css, src/components/pages/projects/ProjectsModern.css
- First made compact (~92px, figure and note on one line) — the user found them too small; now a middle size (~112–129px, was ~144px): label + icon on top, the figure (25–31px) with its note under it, 32px icon circles, a thin bar; tighter header and figures padding. The list starts ~45px higher than before the change.
- deploy: written to the Mac; user to commit

### 2026-11-14 20:15 · Enterprise · Projects page and project pop-up in the modern look
- files: src/components/pages/projects/{ProjectsPage.tsx,ProjectsModern.css (new)}
- ProjectsPage root gets `cl-mod` and imports ../clients/ClientsModern.css, so the header, pills, search, filters and figures match Clients (first figure pine, second green, rest white). ProjectsModern.css adds: the List/Canvas switch as two round icons (pill moves with data-on), list rows as white pills with a lime hover ring and sticky headers on the canvas colour, status pills without outline (open mint, on hold amber, closed grey), canvas columns soft grey with white cards.
- Project pop-up (.pjd): no dark header — avatar circle, name, chips as pills, the delivered ring in pine; one-level pill menu (open page Next green, lime count); white borderless section cards; figures (Sold, billing's Contract value) pine, the rest soft cards; phases with round dots, the current one green with a lime halo and a lime "now"; inner panels soft (no card on a card); one sentence-case label style.
- tags: PORT? (src/base projects if Base wants it)
- deploy: written to the Mac; user to commit

### 2026-11-14 19:30 · Enterprise · Sidebar: back to the attached rail, refined (replaces the floating version of 19:00)
- files: src/components/framework/AppLayout.css (Enterprise's own; src/base/framework untouched)
- The user preferred the old rail: full height, attached, the page you're on as the white shape — the floating lime card is undone (rail widths and the app background back to before). Refinements on top: a cleaner, deeper pine gradient without the moving sheen, a hairline edge, a soft mint glow on the white pill, hover as a soft wash, pill-shaped items in the wide sidebar, pill tooltips, a rounder account menu.
- tags: PORT?
- deploy: written to the Mac; user to commit

### 2026-11-14 18:40 · Enterprise · Client pop-up Contracts tab like the contract window + "Open in Contracts"; clients list header opaque
- files: src/components/pages/clients/{ClientWorkspace.tsx,ClientWorkspaceModern.css,ClientsPage.tsx,ContractsBoard.tsx,ClientsModern.css}, src/components/framework/i18n/*.json
- Client pop-up › Contracts: the summary is now ViewHero (imported from sales/extras/ContractView) — Recurring today (pine, a bar per running subscription), Signed net, and the lime Term card of the nearest renewal — the same cards as the contract window. A bar above it: "N contracts · x of y products running" + "Open in Contracts"; every contract gets an "Open" button.
- ClientWorkspace gains optional `onOpenInContracts(ckey?)`; ClientsPage closes the pop-up, switches to the Contracts tab and passes `focus {q, ckey, n}` to ContractsBoard (new optional prop): it searches that client and opens that contract once the list is in (groups too).
- Pop-up tables cleaned: no outlines, soft head, light rows, current year lime with a lime "now" pill, years strip as pills (current lime), partner "—" grey (red only with a real partner cut).
- Clients list (list view): the column header row is sticky on the canvas colour with a fade below — rows no longer show through it.
- tags: PORT?
- deploy: written to the Mac; user to commit

### 2026-11-14 18:15 · Enterprise · Client pop-up in the modern look; Contracts tab without services
- files: src/components/pages/clients/{ClientWorkspace.tsx,ClientWorkspaceModern.css (new)}, src/components/framework/i18n/*.json
- Contracts tab of the client pop-up holds only products: the "Services" figure in its summary is now "Signed products" (running of all), and the "Service engagements" section and its menu entry are gone — services live in Projects. (Contract figures already left services out.)
- Look (ClientWorkspaceModern.css, scoped `html body .cw-backdrop > .cw`): no dark header band — avatar circle, name, tags as pills, header figures as small cards (Signed in Next pine); one-level menu as pills (sub-links hidden), the open page in Next green with a lime count; page icons in mint circles; cards white radius 26 without borders; overview figures as separate cards (pine, green, white); contract summary in pine; pill buttons (primary green), segmented filters, softer tables and empty states; upsells / tickets / e-mails / folders follow.
- tags: PORT? (src/base ClientWorkspace if Base wants the look)
- deploy: written to the Mac; user to commit

### 2026-11-14 17:55 · Enterprise · Contracts list: the column headers stay put while scrolling
- files: src/components/pages/clients/ClientsModern.css
- The list scrolled in `.ccb` while the table had its own sideways scroller, which trapped the header row: now `.ccb` scrolls both ways, the table doesn't, and the header row (sort/filter menus) is sticky at the top with a soft fade under it — same approach as the clients list.
- deploy: written to the Mac; user to commit

### 2026-11-14 17:45 · Enterprise · Clients & Contracts + contract windows: Next's greens lead, neon only highlights; tab switch fixed
- files: src/components/pages/clients/{ClientsModern.css,ContractsBoard.tsx}, src/components/pages/sales/extras/ContractTerms.css
- Colour: first KPI card Next pine (gradient), second Next green, the rest white with mint icon circles and green bars; active tab, view switch and primary buttons in Next green; avatars green circles with white initials; Active/Running statuses mint with a jade dot; product pills mint. Neon lime kept for highlights only (hover rings, KPI dots/bars on the coloured cards, the running term card, +% steps, groups, the actions launcher's dots). Contract windows follow (`--cv-dark` → pine, primary buttons green).
- Clients/Contracts switch: the pill now sits exactly on the active half (36px, same width, translateX(100%)), icon + label centred with an 8px gap, 130px each; the actions launcher is a true 44px circle.
- Contract list: 10px gutters and 16px row padding (and the matching minWidth in ContractsBoard) so all columns fit from 1440 wide without scrolling.
- tags: PORT? (if Base adopts the look)
- deploy: written to the Mac; user to commit

### 2026-11-14 17:20 · Enterprise · Clients & Contracts overviews in the modern look (light canvas, pills, dark + neon lime)
- files: src/components/pages/clients/ClientsModern.css (new), src/components/pages/clients/ClientsPage.tsx (root gets `cl-mod`, imports the new sheet)
- The Clients page (both tabs) drops the dark header card: title on the light canvas, search / filters / views / view switch / tabs / actions as 44px white pills (active tab and view: near-black with neon lime), KPI cards borderless (first near-black with lime, second neon lime, rest white, icons in circles), client and contract cards white radius 26 with a lime ring on hover, list rows as white pills, statuses neon lime while active/running, avatars as dark circles with lime initials.
- Everything scoped under `html .cl.cl-ov.fh.cl-mod` — Projects (.pj-page) and Customer success keep their look; no shared CSS changed.
- tags: PORT? (Base Clients page, if Base wants the same look — Base has started its own modern look too)
- deploy: written to the Mac; user to commit

### 2026-11-14 16:50 · Enterprise · Contract windows: modern look (light canvas, borderless cards, pills, dark + lime cards)
- files: src/components/pages/sales/extras/{ContractView.tsx,ContractTerms.css}, src/components/pages/clients/{SignedContractView.tsx,ContractsBoard.tsx,ContractsBoard.css}, src/components/framework/i18n/*.json
- Following the user's reference dashboards: light canvas (#f1f3f2), white cards without borders (radius 26, soft shadow), header and footer float on the canvas, every control a 44px pill (close: circle), primary buttons near-black, icons in circles, client logo in the header (SignedContractRow gains optional `website`).
- ViewHero: `HeroKpi` gains `ico` and `bars` (years / members as thin bars, current in lime); the first card dark, the Term card lime while running (blue before it starts, white when over) with the % of the term, time left and a progress bar. Exported `HERO_ICO`.
- Tables, product cards, side lists (soft rows), the deal summary (ContractSummary, its own value card hidden in views) and the dates chips restyled under `.ctv`; the deal's contract editor unchanged.
- tags: PORT? (if Base shows contracts with these views) — the look could become the CRM's new style
- deploy: written to the Mac; user to commit

### 2026-11-14 · Base — Orbit: smoother card turn (Clients ⇄ Contracts)
- `OrbitModern.css`: the figure cards turn as one continuous motion — old card speeds up to edge-on (0.17s, ease-in), new one carries on from edge-on and settles (0.32s, ease-out), same 40ms stagger both ways, own perspective per card. The old view stays until its last card is edge-on (`:has(.cx-kpis)`, 0.4s). The list below only cross-fades (6px), no sideways slide.

### 2026-11-14 · Base — Orbit: Clients / Contracts figure cards one size, turn over on switch
- `ClientsPage.tsx`, `ContractsBoard.tsx`: every figure card keeps its note and bar rows (empty ones invisible, `.is-ghost`), so Clients' and Contracts' cards are the same height.
- `OrbitModern.css`: switching views, the figure cards turn over in place (rotateY, staggered) instead of sliding with the list. `ClientsModern.css`: `.cx-kpi .is-ghost`.

### 2026-11-14 · Base — Orbit: one table look, header filters and columns in every view
- **All** (`orbit/OrbitAll.tsx`): pick your columns (Actions › Columns: Kind, Position · Company, Email, Phone, City, Country, Address, LinkedIn, Added — kept in `profiles.prefs.orbitAllColumns`); every column filters from its header (ColumnHead), Name sorts A→Z / Z→A; Filters + Views buttons and filter chips like Contacts / Companies. Filters go to `contacts_list` / `companies_list` (shared keys); Kind picks the sides. No SQL.
- **Contacts / Companies**: headers use `framework/ColumnHead` (sort + filter menu), as Enterprise.
- **Alignment fix** (`OrbitModern.css`): lists were `width: max-content`, so one row with many tags made every row wider than the header and columns slid apart. Header and rows now share `max(100%, --row-min)`; the name cell clips its pills.
- **Tab switch** (`OrbitSwitch.tsx`): light placed by a ResizeObserver (no rAF follow), ignores hidden views, 40/120 ms hover intent; removed `content-visibility: hidden` on idle panes (it left the light at width 0).

### 2026-11-14 · Base · Orbit: snappier switch and view changes, client KPIs, no sort pick (v78)
- `OrbitSwitch.tsx`: hover intent 40 ms to open / 90 ms to close (was 110 / 220); the light follows the buttons for 360 ms (was 760).
- `OrbitModern.css`: the names open/close in ~0.25–0.3 s (were ~0.6 s), the light glides in 0.32 s (0.7 s); changing view: the old list leaves in 0.16 s, the new one comes in 0.38 s from 0.04 s (were 0.28 s and 0.75 s from 0.2 s); idle views get `content-visibility: hidden`.
- `ClientsPage.tsx`: Clients in Orbit shows its KPI cards again (no more `noKpis`, like Contracts and Enterprise); the "Most recent" sort pick next to Views is gone (sort from the column headers / Filters).

### 2026-11-14 · Base · Orbit: Contracts view, Enterprise's client pop-up, modern look (v77)
- **Client pop-up = Enterprise's** (ported 2026-11-14 ~21:00): `pages/clients/ClientWorkspace.tsx` is now Enterprise's current file with Base's three changes re-applied (supabase path, `ClientTeam` section after Contacts, `NO_TICKETING` hides Tickets / Emails) + `ClientWorkspace.css` and `ClientWorkspaceModern.css`. So: modern look, Contracts tab with ViewHero (Recurring today, Signed net, Term) + "Open in Contracts", focus on a contract, grace months, valuation rights.
- **Contracts view in Orbit** (`?view=contracts`, after Clients in the switch, same access as Clients): `ClientsPage` gets `mode="contracts"` and renders Enterprise's `ContractsBoard` (cards / list, KPIs, filters, views, columns, merge, as-of calendar) under the same header; opening a contract → `SignedContractView`; its client → the pop-up. "Open in Contracts" in the pop-up switches Orbit to Contracts and focuses that client (event `next:orbit-contracts-focus`). The Contracts pane mounts only when first opened.
- New in Base (copies of Enterprise's, imports re-pointed): `framework/{asOf.ts, NumInput.tsx, ColumnHead.tsx/.css}`, `pages/clients/{ContractsBoard.tsx/.css, SignedContractView.tsx, contractGroups.ts, contractRows.ts, ClientsModern.css}`, `pages/sales/extras/{ContractView, ContractModal, ContractPlan, ContractSummary, ContractTermsForm, ContractConfirm, ContractClientList}.tsx, ContractTerms.css, contractsApi.ts`. Small additions: `salesApi.ts` `saveClientProducts(…contractTrackingId)` + `ContractTerms.graceMonths`; `pageAccess.tsx` `ClientEditAction` + "valuation".
- **Modern look for all Orbit views**: new `pages/orbit/OrbitModern.css` — light canvas, no dark header card; the view switch, search, Filters, Views, count and Actions as 44px white pills (the view in Next green, Actions a pine circle with lime dots); list tables as borderless white 26px cards; Clients / Contracts use Enterprise's `ClientsModern.css` (`cl-mod`). Switch and Actions sit in the same spot in every view.
- Contract groups need SQL 136 (Enterprise's, not applied yet): without it the board just shows no groups.

### 2026-11-14 · Base · Settings › Your account: you + your company (v76, SQL 137)
- New `pages/settings/AccountSettings.tsx/.css` (prefix `.ya-`), rendered by `SettingsPage.tsx` for the account view (the old password/sign-out block and its state moved there). Left: you — first/last name, phone, job title (own `profiles` row), sign-in e-mail read-only, password, sign out (scope local). Right, only for the boss / org superadmin: the plan (users vs `tenants.max_users`, last price per user/month and discount, last invoice, paid so far), **Billed as** (several legal entities / tax IDs, one starred default, add / edit / remove) and **Billing history** (date, number, billed-to + tax ID, users, total, status; open one for period, due, paid, users × price × months, discount, net, VAT, total, PDF).
- SQL **137** `src/base/sql/137_tenant_billing.sql`: `tenant_billing_manager()`; `tenant_billing_entities` (RLS: the company's boss / org superadmin read+write, platform superadmin all; trigger keeps one default); `tenant_subscription_invoices` (number, issued/period/due/paid dates, plan, users, price_per_user (per month), discount_pct, net, vat_pct, vat, total, currency, status pending/paid/overdue/void/refunded, bill_to_* snapshot, lines jsonb, pdf_url, notes; RLS: the company's boss reads, **only platform superadmins write**). Applied 2026-11-14 20:02.

### 2026-11-14 · Base · Settings › Integrations: modern look (v75)
- New `IntegrationsModern.css` (imported in `Integrations.tsx` after `Integrations.css`, scoped `.ig`). No dark header block: round white back button, ink title, white pill search with a lime focus ring. The three lists are borderless white 24px cards with lime/grey count pills; rows are rounded with a round chevron (fills with the app's colour when open). Detail panel: 24px with an app-coloured ring; accounts, guides and key forms as soft grey cards; buttons, inputs, selects and segmented switches as pills; guide step numbers in lime. Pure CSS, no logic changes.

### 2026-11-14 · Base · Settings: longer translations stay inside the cards (v74)
- `SettingsModern.css` + `InterfaceSettings.css` only. Landing: figure chips wrap onto a second line and cut with "…" instead of spilling out (e.g. "Al pasar el ratón · etiquetas del menú"), card titles and group lines cut with "…". Interface: language / mode names cut with "…", long notes wrap, languages go 2×2 only under 1180px.

### 2026-11-14 · Base · Settings › Interface rebuilt: language, sidebar modes, small icons (v73)
- New `src/base/framework/dockPrefs.ts` (Base copy of the kernel's `components/framework/dockPrefs.ts`, same keys/events/prefs: `prefs.dockLabelMode` hover/below/side, `profiles.dock_labels` kept in step; plus `DOCK_COMPACT_KEY/EVENT` = `next.dockCompact` / `next:dock-compact`, `prefs.dockCompact`). A person's choice is the same in both tiers.
- `framework/AppLayout.tsx`: mode + compact state like Enterprise's (`app-shell rail-compact / rail-labels / rail-side`). `framework/Dock.tsx`: `mode`/`compact` props, `is-${mode} is-compact` on the rail, the Expand/Collapse button at the foot, the account row with name + e-mail in the wide sidebar, ⌘K tag on Search, tooltips only in hover mode. `framework/AppLayout.css`: Enterprise's current sidebar CSS (small icons, sidebar v3/v4) + Base's Orbit animation.
- New `pages/settings/InterfaceSettings.tsx/.css` (modern look): Language (EN/ES/DE/NL via the kernel's `components/framework/i18n/i18n.ts`, saved to `prefs.lang`), Sidebar (3 modes with a little preview + Small icons switch), Toolbar order (drag / up-down / reset). `SettingsPage.tsx` renders it; the old labels on/off switch and its state are gone; the landing card shows language + menu-label mode.
- Sign-out in Base (`Dock.tsx`, `SuperAdmin.tsx`, `SettingsPage.tsx`) now uses `signOut({ scope: "local" })`, as asked in §8.

### 2026-11-14 · Base · Settings landing: all on one screen (v72)
- `SettingsModern.css` only. Header subtitle removed; the title + search row is sticky with its own background (nothing shows through when scrolling). "Your company" and "Just you" sit side by side (3 cards each), "Pages" below with horizontal cards (icon left, name + two lines, arrow in the corner). Everything fits one screen at 1440×900 and wider; under 1250px the groups stack again.

### 2026-11-14 · Base · Settings landing: colour back, more air (v71)
- `SettingsModern.css` only. Each card uses its own accent again: glossy colour icon tile, a soft glow of its colour in the corner, the round arrow and figure chips tinted, hover = lift + accent ring + accent shadow, arrow fills with the accent. Bigger gaps (18px between cards, 46px between groups). Slim header kept.

### 2026-11-14 · Base · Settings landing: clean cards (v70)
- `SettingsModern.css` only. Slim header row (title, one line, pill search with a lime focus ring), no hero block. Each group: heading + a line, then white 22px cards (soft green icon tile, round arrow, name, description, green figure chips on the company cards). Hover lifts the card with a lime ring, the icon turns forest with a lime glyph and the arrow turns lime. Company and "Just you" rows fill the width (auto-fit).

### 2026-11-14 · Base · Settings landing: simple (v69)
- `SettingsModern.css` only. No hero block: a slim row with "Settings" and a white pill search. Groups are just a small uppercase heading and plain white cards (round green icon, name, one or two lines); no panels, stats, arrows or bento. Lime only as the hover / focus ring. The `.st` pages and the page-settings shell styles from v68 stay.

### 2026-11-14 · Base · Settings landing + page-settings shell: modern look (v68)
- New `SettingsModern.css` (imported in `SettingsPage.tsx` after `SettingsPage.css`); the only TSX change is `sty-group is-${g.k}` on each landing group.
- Landing: Next's pine hero kept (lime dot after "Settings", lime focus ring on the pill search). Groups are big white 28px panels — "Your company" and "Just you" side by side, "Pages" full width below. Tiles are soft grey; hover lifts them to white with a lime ring, the round icon turns pine with a lime glyph, the arrow turns lime. Company tiles show their figures as big dashboard numbers.
- Pages behind it (`.st`): neutral grey canvas instead of the green wash, ink titles, round back buttons (lime on hover). Page-settings shell (`.st.sx`: Deals, Companies, Contacts…): pine round badge with lime icon, pill nav with a lime-ringed indicator, 26px sections, round chevrons.

### 2026-11-14 · Base · Organization: columns fill the width (v67)
- `OrgModern.css` only: no max-widths on the four columns; they all grow (ratios 0.85 / 1 / 1.25 / 0.75, the chart the least), so no empty space is left on the right on wide screens.

### 2026-11-14 · Base · Organization: calmer, one thing open at a time (v66)
- `OrgSteps.tsx` + `OrgModern.css`. UI only, no data changes.
- The chart column is narrow (≈330px); the three step columns take the room. The step pill's ring no longer gets clipped.
- Secondary lines show only on hover or when active: step subtitles, "N people" / level under departments and people, the Departments subtitle.
- Step 2: "People" and "Pages it opens" are two folds — one open at a time (new state `deptView`); opening Pages slides it up over the list, the closed one is a pill with a summary.
- Step 3: About them / Security level / Place in the team / Pages are accordion sections (new `Sec` component, state `pSec`, "About them" open first); closed ones show a one-line summary.

### 2026-11-14 · Base · Organization + Products & Services: lighter modern look (v65)
- `OrgModern.css` / `CatalogModern.css` only. Less black: ink stays only for the main action ("New", "Add") and text. Chosen items (department, person, level, page chips, chart nodes, top tier) are now a soft lime wash `#f2f9dc` with a lime ring instead of ink cards; icons are soft grey/lime circles; segmented switches use a white light on a grey track; the opened product / service is a white card with a soft shadow; step numbers are lime.

### 2026-11-14 · Base · Organization + Products & Services: modern look (v64)
- New `OrgModern.css` (imported in `OrgSteps.tsx`, scoped `.os`) and `CatalogModern.css` (imported in `BaseCatalog.tsx`, scoped `.cat.bc`, plus the portalled `.bc-kind-pop` / `.bsm-backdrop`). Pure CSS, same family as Pipelines (v63): ink `#17201b`, lime `#d6f56b`, grey `#f3f4f2`, white 26px cards, pills, round dark icons, no coloured stripes.
- Organization: step pills on top (current = ink, done = lime check), chosen department/person = ink card, pill inputs/buttons, levels and page chips as ink pills when on, the chart as pills with a department dot.
- Products & Services: each column is now one big white card with grey pill rows inside (small restructure); round white tiles (ink + lime on hover), ink price, opened product = grey card with an ink outline, billing switch with an ink light, top tier highlighted in ink, lime Save. Service pop-up and New/kind menus restyled to match. No logic or DB changes.

### 2026-11-14 · Base · Pipelines page: modern look (v63)
- New `src/base/pages/settings/PipelineModern.css`, imported in `PipelinePage.tsx` after `PipelinePage.css`. Pure CSS, scoped under `.pl.plv` (plus `.plv-pop` and `.pl-del-backdrop` for the portalled menus/dialogs).
- Same family as the Pipeline library: grey `#f3f4f2`, white 26px cards, ink `#17201b`, lime `#d6f56b`, pill buttons/inputs/selects, round dark icons, no coloured stripes.
- List: active pipeline = dark ink card; round icon buttons; ink "New" pill. Header: white, lime Sales pill, grey journey track (active step ink + lime ring), lime Save pill, settings drawer with pills.
- Line: grey rounded phase cards (selected = ink card, lime ring %), grey numbered dots, pill "Add a phase"; Won/Lost as soft green/red pills with dark round icons. Side panel, menus and delete/unsaved dialogs restyled to match. No logic or DB changes.

### 2026-11-14 16:30 · Base · Pipelines library + guide: new look, and a card that invites you in
- files: `pages/settings/PipelineLibrary.tsx` / `.css`, `pages/settings/PipelinePage.tsx`.
- New look (towards where the CRM is going): soft grey canvas, big rounded white cards (26 px), dark ink (#17201b) + one lime highlight (#d6f56b), pill buttons and pill segmented filters. No more coloured stripes: each sector card has a dark round icon, a "N phases" chip and a mini bar chart of its close %; the chosen card turns dark. Detail: dark hero card (sector, phases · chance to win · endings) + phase rows; "Use this pipeline" pill with a lime arrow. Empty detail: animated stack of cards. The guide follows: dark coach panel, white step panel, ink progress with lime ticks.
- **Promo card** at the foot of the pipeline list (dark, glowing, sector icons): "Pipeline library — Explore" + "Guide". Shown whenever there are pipelines (with none, the welcome does the job).
- deploy: front only.

### 2026-11-14 16:20 · Enterprise · Contract windows redesigned: one look, 40px controls, figures as cards, the term as a bar
- files: src/components/pages/sales/extras/{ContractView.tsx,ContractTerms.css}, src/components/pages/clients/{SignedContractView.tsx,ContractsBoard.tsx,ContractsBoard.css}, src/components/framework/i18n/*.json
- ViewShell (the contract view frame): state chip next to the title, the value pill dropped from the header (the cards show it), every header/footer control 40px; new props `size: "sm"` (window fits its content) and `ico`. New `ViewHero`: KPI cards (first one dark green) + a Term card with a progress bar (signed → starts → ends/renews, % through, time left).
- Signed contract and deal contract views open with ViewHero; the side's Terms/Customer are key–value lists; one label style everywhere. Group view and Merge rebuilt on ViewShell + ViewHero, contracts as aligned rows (dates, state, yearly value, actions).
- All styles scoped under `.ctv` — the deal's contract editor (ContractModal) is unchanged.
- tags: PORT? (if Base shows contracts with ContractView/SignedContractView)
- deploy: written to the Mac; user to commit

### 2026-11-14 15:40 · Base · Settings › Pipelines: library of 15 sector pipelines + a guided set-up
- files: `pages/settings/pipelineTemplates.ts` (new), `pages/settings/PipelineLibrary.tsx` + `.css` (new), `pages/settings/PipelinePage.tsx`.
- **Library** (book icon in the list header, or New → "From the library"): 15 ready-made sales pipelines by sector — law firm, clinic, software implementation, SaaS, accounting, consulting, marketing agency, real estate, construction, architecture, insurance, training, industrial B2B, recruitment, hotels & events — filters by group, search, preview of the phases with close % (animated), "Use this pipeline" or "Shape it in the guide".
- **Guide** (New → "Guided set-up", or the welcome when there are no pipelines): 5 animated steps — what a pipeline is (deals moving across a board) → your sector (15 + "Something else") → your phases (rename / reorder / add / common-phase chips, 3–7 health check) → close % per phase + Won / Lost → name + "Sales pipeline" → create, confetti, "Open it in the editor".
- Created pipelines are normal ones (`createPipelineFrom`): phases one under the other (pos_y = i × 140), arrows between them, Won (pos 0) / Lost (pos 260) at the end with arrows from the last phase, `close_probability` per phase, `is_sales`, optional folder, `description` "From the library: …" (skipped if the column isn't there). No DB change.
- No pipelines yet → the main area shows a welcome with "Guide me" / "Browse the library".
- tags: PORT? (Enterprise Settings › Pipelines could reuse pipelineTemplates.ts + PipelineLibrary.tsx as they are)
- deploy: front only.

### 2026-11-14 10:30 · Enterprise · Contracts: merge a client's contracts into one, net/gross yearly value, group at deal close
- files: src/components/pages/clients/{ContractsBoard.tsx,ContractsBoard.css,contractRows.ts,ClientWorkspace.tsx,contractGroups.ts (new)}, src/components/pages/sales/trackings/{HandoffClientForm.tsx,HandoffClientForm.css,TrackingDetail.tsx}, src/components/framework/i18n/*.json, sql/136_contract_groups.sql
- Contracts list/cards: a tick on hover (takes the logo's place on cards); pick contracts of one client → floating bar → Merge → choose the main one (first signed recommended). The group shows as one row with a counter next to the name: its yearly value adds up the members still running (ended ones don't count), start = first start, end = last end. Clicking it opens the group: members, Make main / Take out / Ungroup.
- Yearly value net (minus partner share, as before) and gross: KPI options "Yearly value · net" / "Yearly value · gross", columns "A year · net (€)" / "A year · gross (€)" / "Contracts in it". contractRows gains perYearGross / lastPerYearGross; ClientWorkspace gains lineAnnualLastGross.
- Deal won for a client that already has contracts (attach mode of HandoffClientForm, new optional prop `groupWith`): "Group with an existing contract" picker in the contract step; on confirm TrackingDetail puts `t:<deal id>` into the picked contract/group.
- Without 136 the list just shows no groups and merging says it needs the SQL.
- tags: DB, PORT? (src/base clients/contracts + HandoffClientForm if Base wants it)
- deploy: written to the Mac; user to commit; 136 to apply in Supabase

### 2026-11-13 22:45 · Enterprise · Contracts: fixed terms that are over show as Ended; clients aligned left
- **Files:** src/components/pages/clients/ClientWorkspace.tsx (`isActive`) · contractRows.ts · ContractsBoard.tsx/.css
- **Ended contracts:** `isActive(line)` now also returns false when the line has a fixed term (`term_years`), doesn't auto-renew, and its term's last day has passed. Its status still says "active" and `ends_on` is empty, but the contract is over. Fagor Arrasate (1 Sep 24 → 1 Sep 25), Lyntia (4 Apr 25 → 4 Apr 26), Grupo Ibérica / Carfernu and Copcisa were showing "Running". Because the rule is shared, the client page, the Clients list, Customer success and renewals all see them as ended (as-of aware: `nowMs()`). An ended line contract now shows its end date (the latest term end, or `ends_on`), and its Total note says just "ended".
- **Client column:** the title stays centred; the clients (logo + name) line up on the left. Notes too long for a column end in "…" instead of being cut at both sides.
- **Tags:** PORT? — `isActive` and the term rule if Base has its own copy (src/base clients).
- **Deploy:** written to the Mac · user to commit.

### 2026-11-13 11:40 · Enterprise · Marketing rebuilt for one screen + Forms (SQL 135) + three fixes
- **Files:** src/components/pages/contacts/ContactExport.tsx/.css · src/components/pages/contacts/forms/{formsKit.tsx, FormView.css, FormPublic.tsx, MarketingForms.tsx, MarketingForms.css} (new) · src/components/pages/contacts/LinkedInCapture.tsx · src/components/pages/contacts/ContactsPage.css · src/components/pages/sales/sales/SalesMultiFilter.tsx/.css · src/components/routes/AppRoutes.tsx (**KERNEL**: new public route `/f/:token`) · src/components/framework/i18n/*.json · sql/135_mk_forms.sql
- **Layout:** Marketing is one viewport high. The green bar never scrolls. Every tab keeps its toolbar and filters still and scrolls only its content (`.mkx-page` / `.mkx-bar` / `.mkx-scroll`); the composer and campaign report scroll as one (`.mkh-body.is-flow`). The tab is remembered in the session.
- **Overview, rebuilt to fit one screen:** 6 KPI tiles (can be e-mailed, delivered in 90 days, open rate, click rate, social views, form answers); "Coming up" agenda for 14 days; "Last campaigns" open/click bars; "Social, by network"; "Needs you" (posts due, sending or scheduled e-mails, new form answers, drafts, failed posts); a compact "Write with AI".
- **E-mail:** KPI row, a fixed toolbar and a table with open/click bars that scrolls inside itself. Rows have Copy and Delete draft. **Campaign names can be renamed** inline in the list and in the report header (`MkRename`).
- **Social:** one fixed toolbar with network icons, a feed that scrolls, and a side column (by network this month, channels, ideas without a date).
- **Calendar:** six rows that fill the height, a fixed toolbar, and the "Not planned yet" panel.
- **Audiences:** the list column stays and the editor scrolls.
- **Forms (new tab, SQL 135):**
  - **Builder:** 19 question types (short and long text, e-mail, phone, number, URL, date, one choice, several choices, dropdown, yes/no, country, stars, NPS, scale, consent, hidden value from the link, section title, paragraph). Each question can be saved to a contact or company column or a custom field. Live preview on desktop or mobile, drag and drop, autosave.
  - **Status, answers and sharing:** status draft, live or closed. Answers have a summary and a table, a drawer and CSV export. Share gives the link, an iframe snippet and an e-mail block. Settings cover creating contacts, fill versus overwrite, adding to a fixed list, and the thank-you message or a redirect.
  - **Public page:** `/f/<token>` with no sign-in (`FormPublic`). The link reads `e=` (the campaign recipient's e-mail), `q`/`a` (a one-click answer from the e-mail) and `utm_*`. Outlook can't hold form fields, so the e-mail block has one-click answer buttons plus "Answer the rest".
  - **Composer:** a "Form" button inserts a live form into any campaign. `mkToChips` now skips tags, so `{{email}}` inside an href stays a merge field.
- **Fixes:**
  - The audience filter "Company · Company" froze for 1–3 minutes (15k options all rendered). `SalesMultiFilter` now draws at most 200 rows, chosen ones first, with "N more — type to find them". This applies everywhere it is used.
  - The LinkedIn extension listed only the first 1,000 companies (one `select("*")`, so new ones were missing). It now finds the matching company in the database and has a picker that searches every company (newest first when empty).
- **i18n:** ~300 new texts added to es/de/nl (forms filled by visitors stay as written, `translate="no"`).
- **Tags:** KERNEL (route only, backwards compatible) · DB (135) · PORT? — `SalesMultiFilter` render cap if Base has its own copy; LinkedIn capture company picker.
- **Deploy:** 135 applied in Supabase · written to the Mac · user to commit.

### 2026-11-13 08:55 · Enterprise · App language: English, Spanish, German, Dutch (Settings › Interface)
- **Files:** src/components/framework/i18n/{i18n.ts,en.json,es.json,de.json,nl.json} (new) · src/main.tsx · src/components/routes/AppRoutes.tsx · src/components/pages/settings/SettingsPage.tsx/.css · src/components/pages/clients/CsFlow.tsx
- **What:** Settings › Interface › Language picks English / Español / Deutsch / Nederlands. It is kept on the device (localStorage `next.lang`) and in the profile (`profiles.prefs.lang`), and AppRoutes follows the profile on other devices. The whole app is translated at runtime: `startI18n()` loads a dictionary (~11k UI texts pulled from the source, Base included, translated by hand: ES tú, DE Sie, NL je) before the first render. A MutationObserver then swaps text nodes and the placeholder/title/aria-label/alt/data-tip/data-ph/data-placeholder attributes. Texts with values use `{n}` patterns. Hand-built dates, "20 bills" and "Good morning, Inder" are handled by fallbacks. alert/confirm/prompt and Date/Intl dates follow the language. Skipped: textarea, contenteditable, code/pre, `translate="no"`/`.notranslate`, and documents in iframes (proposals/contracts stay as written). No SQL.
- **Rule from now on:** new UI text stays in English in the code. To translate it, add it to the dictionaries (the four JSON files share the same arrays: en.s/en.p = sources, es/de/nl = translations or null). Mark anything that is the user's own content and is not an input with `translate="no"`. Fixed-width controls need short translations (e.g. Management's "Custom" segment).
- **Tags:** PORT? — Base gets it for free: the dictionary already covers src/base texts, and main.tsx/AppRoutes are shared. Base only needs the Settings › Interface picker if its SettingsPage differs.
- **Deploy:** frontend only.

### 2026-11-13 02:40 · Enterprise · Reports home on the home page's grid (drag + resize); modern charts and cards
- Files: src/components/pages/sales/extras/ReportsHome.tsx / .css, ReportCharts.tsx, SalesReport.css
- What: **Reports › Home uses `HomeBoard`** (imported from homepage/HomePage.tsx, kit built in ReportsHome): 24 columns, Customize = adjust mode — drag a card anywhere, pull its right / bottom / corner edge, size menu (Small / Medium / Large / Full width / Figures strip) + "Shows" (figures / each chart / first rows; table rows 6 · 12 · 30), what it shows also in the card's bar (≥400px), × removes; two-by-two below 980px, one column on phones. `prefs.reports_home` is now `{ v: 2, widgets: [...with x, y, w, h] }`; v1 boards (fixed s/m/l widths, in order) and the starter board are placed on the grid once (`placeAll`, firstFit). **Cards**: white, 24px radius, soft shadow, icon chip, title + subtitle, round "open" button; figures are KPI tiles (coloured dot, big number, mini bars in their colour). **Charts (everywhere)**: soft full-height tracks behind round column bars, pill horizontal bars, thick donut with gaps and the total big, smooth curved lines (Catmull-Rom), dark tooltip, % pills in legends; charts fill whatever size the card has.
- Tags: PORT? (src/base reports, if any)
- Deploy: frontend only

### 2026-11-13 02:05 · Enterprise · Reports: everything in the header, the board uses the whole width; more chart colours
- Files: src/components/pages/sales/extras/SalesReport.tsx / .css, ReportsHome.tsx / .css, ReportCharts.tsx
- What: The Reports banner is one row: **Reports · Home | New report · Jump back in ▾ (latest 8 saved reports) · Saved reports ▾ (count; a panel with search, folders, + Folder, move / rename / colour / delete — what was the left column) · Refresh · Customize/Done** (Customize only on Home). The subtitle, the left "Saved reports" column, the second Home/New report tab bar, the Jump back in chips and the board's own Refresh/Customize are gone: the board and the report builder take the whole width under the banner. `ReportsHome` now takes `custom`, `onCustom`, `refreshTick` (no `tabs`); Reset sits in the "Add to your home" bar. Panels close on an outside click / Esc / opening a report. **Charts**: `PALETTE` is multi-hue (green, blue, amber, violet, rose, cyan, orange, indigo, lime, pink, teal, slate); a one-series bar / column chart gives every bar its own colour; funnel steps one hue each.
- Tags: PORT? (src/base reports page, if it has one)
- Deploy: frontend only

### 2026-11-13 01:40 · Enterprise · Reports: faster, no more errors on opening; contracts in reports as Clients › Contracts shows them
- Files: sql/134_fast_deal_visibility.sql (new, applied), src/components/framework/ErrorBoundary.tsx + .css (new), src/components/pages/clients/contractRows.ts (new), clients/ContractsBoard.tsx, src/components/pages/sales/extras/salesReportEngine.ts, ReportsHome.tsx, SalesReport.tsx, src/components/pages/homepage/reports/HomeReports.tsx
- What: **Errors / slowness**: for a sales rep every page of deals (and of deal products, tasks, contacts…) evaluated `can_see_tracking()` per row (~2 s a page) — Reports reads thousands of them and hit the statement timeout → SQL 134 (same visibility, one array check per row). **Reads**: `readAllRows` now uses `pagedAll` (6 pages at a time, each retried; no more silently cut lists); `partsUsed(cfg)` = the parts a report really uses (+ its added parts and the links on the way; `deal.company` / `contact.company` need companies) and `loadCrmData(source, step, extra, only)` reads only those — a deals chart no longer reads 18k companies + 30k contacts. Reports › Home and Home's report cards read every part in parallel. The report builder shows the report from its parts first, then reads the rest in the background ("Reading the rest…" chip). `ErrorBoundary` around the Reports page and each widget chart: a crash shows its message + Try again instead of a blank page. **Contracts in reports** (`agreement`): built like Clients › Contracts — contracts built on deals (tracking_contracts, active; a deal with them is told by them), deal terms + signed products, lone signed products (`contract_tracking_id` respected); shared figures in `clients/contractRows.ts` (dealContractFigures / linesContractFigures, ContractsBoard uses them too). New fields: Contract, Made from, Contract template, State (incl. In grace period), A year today (with increases), A year (ended: when they ended), Contract year running, Increase since year 1 %, Next increase % / on, Grace period (days), Paid, Next invoice / amount; Contract total = products only (matches Clients › Contracts). Signed products (`contract`): State, A year before the partner's cut, Contract year running. Default columns of a new contracts report updated. Links deal↔agreement go by `tracking_id`.
- Tags: DB (Base deals use the same tables: faster for its reps too); PORT? (src/base reports engine, if Base has one)
- Deploy: SQL applied; frontend

### 2026-11-13 00:55 · Enterprise · Proposals can carry the deal's contracts; the signed-contract view shows no services
- Files: src/components/pages/sales/trackings/TrackingDetail.tsx, src/components/pages/sales/sales/salesApi.ts, src/components/pages/sales/sales/SalesPage.css, src/components/pages/clients/SignedContractView.tsx
- What: **Proposals × contracts**: `ProposalLine.kind` can be `"contract"` (group = line = `tracking_contracts.id`; null = left out). The proposal editor lists the deal's contracts first (templates with `in_proposals = false` stay out); a contract picked in a proposal **leaves out by itself every product line it holds** (same catalogue product) — shown as "Already in <contract>", not saved as picked, back when the contract is taken out. Figures use the contract's total. Making a proposal main sets each contract in it `active` (counted on the deal) or not (`setMainProposal`), and excludes the held product lines as usual. Proposal documents (studio / generator) get each contract as one product line with its items as rows (deck rules see the held products). **Clients › Contracts › full view** (SignedContractView): no services anywhere (no "Services sold with it", no Services figure, no "Services billed", contract value list/discount without services).
- Tags: PORT? (src/base has its own TrackingDetail proposals: only if Base adds deal contracts)
- Deploy: frontend only

### 2026-11-12 18:10 · Enterprise · Home: report charts as cards, pick the stages of a pipeline, two-by-two on narrower screens
- Files: src/components/pages/homepage/HomePage.tsx / .css, consultancy/ConsultancyHome.tsx, sales/SalesHome.tsx / .css, sales/StagePick.tsx + .css (new), reports/HomeReports.tsx + .css (new), src/components/pages/sales/extras/ReportsHome.tsx (exports `compute`, `Widget`, `Res`, `WShow`), SalesReport.tsx (exports `TEMPLATES`, `fromSaved`)
- What: **Board items carry settings** (`BoardItem.cfg`, saved in `prefs.homeBoard`); `HomeSlot` gets `cfg` + `setCfg`, `renderSlots(slots, (key, slot) => …)`. **Pipeline by stage**: one dropdown (StagePick) for the pipeline and which of its stages to show (none = all; "Only" per stage; at least one stays on), per card, saved straight away (also outside Adjust). **Reports on Home**: new card `report` (dept/library section "Reports", page access `reports`): any saved report you can see or a ready-made one, showing one of its charts, its figures or its first rows — same maths as Reports › Home (`compute`), CRM read once per source and kept for the visit (15 min). Several report cards allowed; in Adjust the bar (≥400px) or the size menu ("Shows") switches what a card shows. **Responsive**: phone (<760px board) one column as before; new **two by two** below 980px board width (`duoLayout`: half / full width cards, reading order, shorter column first; the saved layout is untouched; no drag/resize there, add / remove / settings still work); 24 columns above.
- Tags: none (Enterprise home only; Base home has no board)
- Deploy: frontend only

### 2026-11-12 16:45 · Enterprise · Contracts list: centred columns, even spacing, nothing spills
Files: src/components/pages/clients/ContractsBoard.tsx, clients/ContractsBoard.css
What:
- Every column after Contract is centred, header and cells alike (like the Clients list).
- The widths are shares (fr) with a minimum each: Contract 1.7fr ≥190px; client / products ~1.2fr ≥140px; state 0.85fr; dates 0.75fr; figures 0.85fr. Column gap 16px. The default 9 columns fit at 1440px.
- Cells clip: long client names end in "…" and product tags wrap inside their column. The client logo's initials are centred.
Tags: none
Deploy: none

### 2026-11-12 16:30 · Enterprise · Clients header: the right-hand controls as one set
Files: src/components/pages/clients/ContractsBoard.css
What: The cards/list toggle, the as-of calendar, the Clients | Contracts switch and the Actions button are all 40px tall now (the switch's inner buttons 32px), share the same glass (12px radius, white 8% / 12% border) and sit 8px apart. Before, they were 40 / 46 / 46px with 18–28px gaps.
Tags: none
Deploy: none

### 2026-11-12 16:10 · Enterprise · Clients / Contracts "as of" any day (header calendar); Products column on Contracts
Files: src/components/framework/asOf.ts (new), pages/clients/ClientWorkspace.tsx, clients/ClientsPage.tsx, clients/ContractsBoard.tsx, clients/ContractsBoard.css, clients/SignedContractView.tsx, sales/extras/ContractView.tsx
What:
- framework/asOf.ts is a shared "as of" clock: getAsOf / setAsOf / useAsOf (useSyncExternalStore), nowMs(), todayIso().
- ClientWorkspace's helpers read it instead of the real clock: todayISO, runsAt, lineAnnual(Gross), contractYearOf, termOf, renewalOf and isActive. So does contractState in ContractView, and so do the Contracts board, the contract views and Clients' rows.
- The Clients page header has a calendar button (custom DatePicker). Picking a day shows Clients and Contracts — KPIs, rows, states, contract year and increase, next invoice, the pop-ups — as they stood that day.
  - Only what was signed by then is shown. A client counts as churned only if its churn date had come.
  - The button turns amber with "As of 15 Mar 2028"; × goes back to today, and leaving the page resets it.
  - The contracts cache isn't used or written while a day is picked.
- Contracts has a new "Products" field / column: the kinds of product a contract carries (multi-select; it filters from the header or the Filters panel), shown as chips. It replaces the old count and is in the default columns. Column widths were tightened.
Tags: PORT? (Base, if it wants an "as of" view)
Deploy: none

### 2026-11-12 15:40 · Enterprise · Contract pop-up: restyled, and everything editable in it
Files: src/components/pages/clients/SignedContractView.tsx, clients/ClientWorkspace.tsx, clients/ContractsBoard.tsx, sales/extras/ContractView.tsx, sales/extras/ContractTerms.css
What:
- Restyled: a calmer header, sections as cards, and an "Edit" button in the header.
- Editing a signed-products contract happens in place (an amber "Editing" badge, Cancel / Save changes). Closing with unsaved changes asks via ContractConfirm.
  - The contract: signed, starts, length, non-terminable, renewal / notice, invoicing, due days, contract No., currency, notes. A shared field is carried onto every product's editor.
  - Each product: status, billing, price, set-up fee, dates, length, yearly increase, renewal, partner's cut, notes.
  - The customer (legal name, VAT, address, country).
  - People: contact person, platform admin, billing contact (saved on every product).
  - The signatories (add / remove, which side), e-signature provider and ID, terms link.
- Saving writes the contract (onto its products and the deal's order form `contract_terms`), then each product that changed; each year's amount is rebuilt when price, term or increase change.
- ClientWorkspace's line and contract editors now use the same exported functions: contractEditValues / saveContractEditValues (with `extra` for more of the order form) and lineEditValues / saveLineEditValues (which also takes billing contact and notes). Behaviour is unchanged.
- A deal-built contract's view has Edit too: it opens the deal's ContractModal, and the list reads the contracts again after a save.
Tags: none
Deploy: none

### 2026-11-12 15:15 · Enterprise · Contracts › "A year": value with its rise, then the value before it + %
Files: src/components/pages/clients/ContractsBoard.tsx, clients/ContractsBoard.css
What: The "A year" cell is simpler now. The staircase and the next-rise date are gone. It shows this contract year's value with its increase in large, and under it — only when it rose this contract year — the value before that rise and a green "+5%" pill.
Tags: none
Deploy: none

### 2026-11-12 15:05 · Enterprise · Contracts › "A year": clearer increments
Files: src/components/pages/clients/ContractsBoard.tsx, clients/ContractsBoard.css
What: The "A year" cell now shows:
- this contract year's value;
- a green "↑ 5%" pill when it rose this contract year (vs the year before, not vs year 1);
- a tiny year-by-year staircase with the current year in green;
- "Year 2 of 3 · +5% 1 Mar 27" for when the next rise comes.
Hovering lists every year's value and rise. New row fields: yearVals (gross yearly value per contract year), stepNow, nextStep. The total column's note no longer carries a %.
Tags: none
Deploy: none

### 2026-11-12 14:55 · Enterprise · Detailed contract pop-up (near full screen); Clients | Contracts switch always open
Files: src/components/pages/clients/SignedContractView.tsx (new), clients/ContractsBoard.tsx, clients/ContractsBoard.css, clients/ClientWorkspace.tsx, clients/ClientsPage.tsx, sales/extras/ContractView.tsx, sales/extras/ContractTerms.css
What:
- ViewShell takes `wide`: the pop-up fills nearly the whole screen (up to 1820px), two columns, and goes to one column below 1360px.
- A contract made of signed products opens SignedContractView. LinesContractView is gone. It shows:
  - At a glance: value with list and discount, this year with the increase, signed / grace, starts, renews, services.
  - Year by year: calendar contract years, recurring, increase %, one-time, partner, net; the current year is highlighted.
  - Each product: price, list, discount %, value over the term, partner, set-up fee, start, Y1/Y2/Y3 chips with the % up, and the order form's price rows (list, discount, final).
  - The services sold with it (roles, days, discount).
  - Side column: terms (length, non-terminable, renewal and notice, yearly increase, invoicing and payment days, currency / VAT, services billing); customer (legal name, VAT, address, contact person, platform admin, billing contact); signed (signatories on both sides, e-sign provider and ID, signed document, terms link); notes.
  - It reads the deal's contract_terms when there is one.
- ClientWorkspace now also exports partnerCut, partnerTotal, firstYearOf, scheduleOf, periodsAYear and periodLabel.
- A deal contract (ContractView) opens wide too, with a new year-by-year table: list, increase, discounts, invoices that year, net.
- The Clients | Contracts switch is always open (icon + name), via `.cl-mtabs.is-open`. Projects' List | Canvas still opens on hover.
Tags: none
Deploy: none

### 2026-11-12 14:45 · Base · Integrations: Google Analytics (GA4)
- files: `pages/settings/Integrations.tsx`, `api/connectedAccounts.ts` (`syncAssets(id, what?)`), `requests/connected-accounts.index.ts.txt`, `sql/133_connected_google_analytics.sql` (new).
- **DB (133)**: `connected_assets.kind` + `ga_property`. Applied 2026-11-12.
- **Edge function `connected-accounts`** (deployed by Base, now v15): Google logins with service `analytics` (scope `…/auth/analytics.readonly`) read their GA4 properties (Admin API v1beta `accountSummaries`) and, per property, the last 28 days (Data API v1beta `runReport`: activeUsers, sessions, keyEvents + top 3 `sessionSourceMedium`), stored as `ga_property`. `assets_sync` takes `what: "gads" | "analytics"`.
- Front: **Google Analytics** moved from Coming soon to Available (provider google, service `analytics`; "Use here" on a linked Google account); property list with users / sessions / key events / top sources; "Re-read properties"; folding setup guide (enable Admin + Data APIs, analytics.readonly scope).
- tags: DB (133)
- deploy: written to the Mac · SQL applied · function deployed · user: enable the 2 APIs + scope, push

### 2026-11-12 14:35 · Enterprise · Contracts: the yearly value with its increments (contract year by year)
Files: src/components/pages/clients/ContractsBoard.tsx, clients/ContractsBoard.css, clients/ClientWorkspace.tsx
What:
- A deal contract's yearly value used to be total ÷ years (an average). It is now the current contract year's recurring value: that year's list price, with the yearly increments, less that year's discounts, without year 1's one-offs (`dealYearly()`). An ended contract shows its last year.
- Signed products (lines) already used lineAnnual (increments included).
- New on each row: `yearNo`, `incSoFar` (% since year 1) and `incNext` (% next contract year). For lines these are read on the price before the partner's cut (`lineAnnualGross`, now exported), so a cut that ends isn't counted as an increase.
- The "A year" column shows e.g. "Year 2 · +5% vs year 1" (green), "Year 1 · +5% from year 2", or "Year 3 · no increase". The total's note adds "· +5%".
- New fields: Increase vs year 1 (%) and Contract year. "A year" is now in the default columns.
Tags: none
Deploy: none

### 2026-11-12 14:05 · Enterprise · Ended / churned only → figures about them; Contracts scroll
Files: src/components/pages/clients/ClientWorkspace.tsx, clients/ClientsPage.tsx, clients/ContractsBoard.tsx, clients/ContractsBoard.css
What:
- The KPIs on top leave churned clients and ended contracts out of a mixed list, as before. When the filters or view list only those, the figures are about them, at what they were worth:
  - ClientWorkspace has a new `lineAnnualLast(l)`: a line's yearly value on its last running day (its ends_on, or its term's end).
  - ClientRow has new recurringLast / contractLast / productsLast, which the Clients KPIs use when only churned clients are shown.
  - Contract rows have a new `lastPerYear`, used by liveOf() when only ended contracts are shown; the Contracts card then reads "all ended".
  - Ended contracts show "X € a year · ended" instead of "one-time".
- The Contracts list (`.ccb`) scrolls under the header when it doesn't fit.
Tags: PORT? (Base Clients KPIs, if Base filters churned)
Deploy: none

### 2026-11-12 13:20 · Enterprise · Grace period counts everywhere; tickets from Inbox mail no longer vanish
Files: src/components/pages/clients/ClientWorkspace.tsx, clients/ClientsPage.tsx, clients/ContractsBoard.tsx, sales/extras/salesReportEngine.ts, homepage/shared/HomeTodo.tsx, sql/132_ticket_mail_manual.sql
What:
- Rule for the whole app: a signed product in its grace period (signed, start ahead) already counts.
  - `runsAt` (in ClientWorkspace) now counts it from its signing day. So do lineAnnual / lineAnnualGross and everything built on them: Clients' Recurring, a client card's Recurring, Contracts' yearly value, the CS ARR and the reports.
  - The exception is a renewal signed ahead of time: the same product, whose running line's term ends within 60 days of the new start. The old line keeps billing until then, so the two never add up.
  - The lines are registered per client with the new `noteLines()`, from Clients, Contracts, the client pop-up and the report engine.
- Tickets › Inbox › Create ticket said "Cannot coerce the result to a single JSON object". 116's BEFORE INSERT trigger ran before trg_set_tenant, so with no tenant mail_is_known() was false and the row was dropped.
  - Fixed in SQL 132 (already applied).
  - createTicket(…, { byHand }) sends `x-ticket-by-hand: 1`; it retries without the header if a proxy refuses it, and uses maybeSingle with a clear message if a row is still skipped.
Tags: PORT? (Base: runsAt grace rule and noteLines if Base has its own ClientWorkspace copy; createTicket byHand)
Deploy: SQL 132 applied

### 2026-11-12 13:05 · Enterprise · Contracts list as wide as the header; the tab switch closes after a pick
Files: src/components/pages/clients/ContractsBoard.css, clients/ClientsPage.tsx, projects/ProjectsPage.tsx
What: `.ccb` padding is now 0 14px, so the Contracts list and cards line up with the green header's edges, which sit 14px in from the page. The icon-only `.cl-mtabs` switch (Clients | Contracts, and Projects' List | Canvas) no longer stays open after a click. Picking a tab adds `.is-shut` until the pointer leaves, the button is blurred, and `:focus-within` only opens it for keyboard focus (`:focus-visible`).
Tags: none
Deploy: none

### 2026-11-12 12:55 · Enterprise · Contracts: the figures on top are customisable (like Clients)
Files: src/components/pages/clients/ContractsBoard.tsx
What: The Contracts KPIs use the Clients KPI system. Up to 6 cards (the sliders button opens the picker), and ⇄ on a card changes it or gives it a second figure (click the card to switch). They are saved as prefs.contractKpiSlots; the default is contracts, signed value, invoices in the next 90 days and renewing within 90 days. There are 17 figures, among them yearly value, invoices in the next 30/90 days, invoiced this year, next invoice, auto-renewing, in grace, not started, ended, clients with a contract, average value and length, products and discounts given. The figures follow the search and filters, and show skeletons until the data and prefs are read.
Tags: none (Enterprise only)
Deploy: none

### 2026-11-12 12:40 · Enterprise · Clients / Contracts load faster; Contracts get views, column order and header filters
Files: src/components/pages/clients/ClientsPage.tsx, clients/ContractsBoard.tsx, clients/ContractsBoard.css, clients/useClientsData.ts, companies/companiesApi.ts
What:
- Speed:
  - Clients used to read in four rounds, one after another: the clients, then the popup data, then companies (including up to 2000 "twin" companies per batch, only used for search), then the contract terms. The popup data now starts with the page, and its companies and terms are read together. The twin-company search runs afterwards without holding the page.
  - useClientsData keeps the last read per user in memory (CD_CACHE), and so does the client popup data (EXTRA_CACHE). A later visit to Clients or Projects draws at once and refreshes quietly.
  - ensureRenewalDeals runs once per fresh read, never on remembered data.
  - loadPrefs shares one read for 20 s across all its callers, and savePref keeps that copy current.
  - ContractsBoard reads trackings and websites in parallel (only for clients with contracts) and remembers its rows (CACHE).
- Contracts tab:
  - The "Any state" and "Renews first" Selects are gone. It now has a FilterBar (Filters + Views, saved as prefs.contractViews; the view is kept in localStorage np-contracts-view) and FilterChips.
  - 15 fields: contract, client, state, made from, length, paid, products, signed, starts, renews/ends, renews by itself, next invoice, its amount, total, a year.
  - The list's columns are the person's own (prefs.contractColumns), with a drag/hide/add editor opened from Actions › Columns when the Contracts tab is open. Every column header sorts and filters (ColumnHead), and with no sort the rows go renewing soonest first.
Tags: PORT? (Base: the prefs read sharing in companiesApi, if Base keeps its own copy)
Deploy: none (front-end only)

### 2026-11-12 12:15 · Enterprise · Projects list head: header shadow falls over it, Clients-style labels
Files: src/components/pages/projects/ProjectsPage.css
What: `.pj-sheet` sat at z-index 1 (same as the floating header's ::before), so its sticky column head painted a flat band over the header's shadow. It now sits at z-index 0, like the Clients sheet. The head has no rule or band and uses quiet 12px labels (no uppercase), the same as the Clients table head.
Tags: PORT? (Base Projects, if it uses the same sheet)
Deploy: none

### 2026-11-12 12:10 · Enterprise · Projects header = Clients header: search + Filters/Views in the bar, icon-only List/Canvas switch
Files: src/components/pages/projects/ProjectsPage.tsx, projects/ProjectsView.tsx, projects/ProjectsPage.css, clients/ContractsBoard.css
What: Projects now works like Clients. The search and the FilterBar (Filters + Views, saved as prefs "projectViews") are portaled into the dark header (`.cl-bar-tools`). The white row of Selects below it is gone (client / service / status / consultant / sort): those are fields in the Filters panel, and the column-header filters and sorts stay as they were (same np-projects-view). The subtitle is removed. List | Canvas uses the icon-only `.cl-mtabs` switch, which opens on hover; `data-on="2"` is a generic second-position rule in ContractsBoard.css. The header uses the same compact bar, title and KPI sizes as Clients, and keeps its shape while loading (skeleton tools and KPIs).
Tags: PORT? (Base Projects page, if it has the old filter row)
Deploy: none (front-end only)

### 2026-11-12 11:55 · Enterprise · Clients header: icon-only tab switch, no sort select, header keeps its shape while loading
Files: src/components/pages/clients/ClientsPage.tsx, clients/ContractsBoard.tsx, clients/ContractsBoard.css
What: The Clients | Contracts switch shows icons only; hovering (or focusing) it opens both names, growing leftwards over the tools (opaque, no layout jump). The "Most recent" sort Select is gone from the Clients tools (columns still sort from their headers). While the Clients page loads, the header no longer collapses: placeholder tools and KPI cards (shimmer, `.cx-skel`) keep the banner at full height. Contracts KPIs show no sub-line until loaded.
Tags: PORT? (Base: the loading skeleton for the Clients header, if Base's header collapses the same way)
Deploy: none (front-end only)

### 2026-11-12 10:30 · Enterprise · Clients › Contracts: tab switch on the right, client logos, cards / list
Files: src/components/pages/clients/ClientsPage.tsx, clients/ContractsBoard.tsx, clients/ContractsBoard.css
What: The Clients | Contracts switch moved to the right of the bar (white pill with icons), before the actions. The subtitles under the title are gone (just "Clients" / "Contracts"). The Contracts tab now shows each client's logo (CompanyLogo from the company website) and opens as cards by default (logo, state, compact timeline or progress, dates, next invoice, total), with a cards/list toggle (localStorage ccb.layout); the list rows show the logo too.
Tags: PORT? (Base has no Contracts tab; only port if Base adds one)
Deploy: none (front-end only)

### 2026-11-12 12:35 · Enterprise · Clients page: Clients | Contracts tabs, every contract in one list with a pop-up
- Files: src/components/pages/clients/ClientsPage.tsx, clients/ContractsBoard.tsx + .css (new); sales/extras/ContractView.tsx (new), ContractSummary.tsx (noTimeline prop), ContractTerms.css
- What: a Clients / Contracts switch in the Clients header (remembered, localStorage cl.tab). Contracts: KPIs (live contracts, signed value + a year, invoices due in the next 90 days, renewing in 90 days) and a list — search, state filter (Running / In grace period / Not started / Renewed / Ended), sort (renews first, biggest, signed latest, client) — of (1) contracts built on won deals (tracking_contracts: dates, next invoice, total) and (2) older contracts made of a client's signed products grouped by deal (client_products + trackings.contract_terms; skipped when that deal has a tracking contract). A click opens a read-only pop-up: deal contracts show dates (milestones + timeline), what it includes, its terms and the summary with the payment plan; older ones show dates and their products. Buttons: Open the deal (/sales?tracking=…) and Open the client (its workspace, focused on that contract). Esc closes.
- Tags: PORT? (Base has no contracts)
- Deploy: none

### 2026-11-12 12:10 · Enterprise · Sidebar: no scroll when pointing near the bottom
- Files: src/components/framework/AppLayout.css
- What: the glow that follows the pointer was a 220px layer (.rail::after) moved with the mouse; near the bottom it stuck out of the sidebar, and now that the sidebar scrolls that made a scrollbar appear. It is now painted as one of the sidebar's own background layers (radial-gradient at var(--gy)), so it can never overflow. Checked every 8px over the bottom 200px in all label modes.
- Tags: PORT? (Base has the same .rail::after glow if it adopts the scrolling sidebar)
- Deploy: none

### 2026-11-12 11:55 · Enterprise · Sidebar: labels beside the icons (wide sidebar), small icons with any labels, scrolls when zoomed in
- Files: src/components/framework/dockPrefs.ts (new), framework/Dock.tsx, framework/AppLayout.tsx, framework/AppLayout.css; pages/settings/SettingsPage.tsx + .css; pages/sales/sales/SalesPage.css, pages/management/ManagementPage.css, pages/clients/ClientsPage.css, pages/calendar/CalendarSettingsModal.css
- What: Menu labels is now a choice of three (Settings › Interface, with little pictures): on hover · under the icons · beside the icons (a wide fixed sidebar: 228px, 200px on windows ≤1440, 196/180 with small icons; Search shows its ⌘K, the account shows your name and email). Saved as prefs.dockLabelMode (profiles.dock_labels kept in step: true unless "hover"); helpers in dockPrefs.ts. Small icons no longer switch labels off (labels under small icons wrap to two lines). New Expand / Collapse button at the foot of the sidebar toggles the wide sidebar (back to what you had). Zoomed-in pages / short windows: the sidebar scrolls (thin scrollbar on hover) instead of squashing; the account ring no longer makes it scroll. Pages: Deals hero amount wraps under the count instead of "108…", Deals/Management hero cards take their narrow layout earlier with the wide sidebar, client cards min 290px — the calendar-settings `.cx-grid` !important rule leaked into the Clients page (cards 232px) and is now scoped to its month cards. Overrides in AppLayout.css are prefixed `html` so Base's identical .rail rules can't win by load order.
- Tags: PORT? (Base has its own Dock/AppLayout and the same leaky .cx-grid rule in its CalendarSettingsModal.css)
- Deploy: none (no SQL; prefs is jsonb)

### 2026-11-12 11:15 · Enterprise · Kernel: one session per tab — two accounts in two tabs (Base request)
- Files: src/components/api/supabase.ts; logout buttons → `signOut({ scope: "local" })` in src/components/framework/Dock.tsx, framework/SuperAdmin.tsx (act-as fallback), login/LoginPage.tsx (reset → back), pages/settings/SettingsPage.tsx, pages/superadmin/SuperAdminHome.tsx
- What: Base's `requests/supabase-tab-sessions.ts.txt`, applied and hardened. Each tab keeps its own session (sessionStorage); with "Keep me signed in" localStorage holds the remembered session, which only starts NEW tabs and is shared by tabs of the SAME user (freshest token); a tab never overwrites or removes another user's remembered session. Plus: the client's storageKey carries a per-page-load tag (`sb-<ref>-auth-token.tab-xxxx`) that the storage strips, so supabase-js's BroadcastChannel ("signed in/out in another tab") and its refresh lock stay inside the tab — otherwise tab 1 would still be told about tab 2's sign-in/out. Saved keys are unchanged (existing sessions keep working). The sign-in code verifier also goes to localStorage (reset / magic links open in a new tab). Deactivated-user sign-outs stay global.
- Tags: KERNEL · Base: your own Sign-out buttons in src/base still call signOut() (global) — switch them to scope "local".
- Deploy: none

### 2026-11-12 10:55 · Enterprise · Outlook: deleting a CRM meeting cancels it properly (no "Canceled:" copy left)
- Files: supabase/functions/outlook-meeting/index.ts (new, DEPLOYED v1), supabase/functions/outlook-sync/index.ts (same fix, NOT deployed — the Mac copy has other undeployed changes), src/components/api/outlookSync.ts, src/components/pages/sales/sales/salesApi.ts
- What: deleting a meeting now goes through the new outlook-meeting function: a meeting you organise with people invited is cancelled with Graph's /cancel (they're told, it leaves your calendar), anything else is deleted; then every item left in that mailbox with the same iCalUId (the "Canceled: …" copy Outlook drops when your own mailbox was also an attendee) is deleted, right away and again at ~3/11/26 s (EdgeRuntime.waitUntil). outlook-sync's delete is the fallback. When a meeting is synced, your own Outlook addresses (outlook-meeting › me: mail, UPN, aliases — cached) are never put on its attendee list, since your Outlook address can differ from your CRM email. Same two fixes are in the Mac copy of outlook-sync for its next deploy.
- Tags: PORT? (Base uses the same outlookSync.ts? check)
- Deploy: outlook-meeting deployed (verify_jwt on). No SQL.

### 2026-11-12 10:10 · Base · Request: two accounts in two tabs
- files: `requests/supabase-tab-sessions.ts.txt` (new) — request in §8 for `src/components/api/supabase.ts` (`smartStorage`) + logout `signOut({ scope: "local" })`.
- deploy: nothing deployed — Enterprise to apply.

### 2026-11-12 10:30 · Enterprise · Contract windows: near full screen, calmer colours, steps that fold; lost reason from the deals board
- Files: sales/extras/ContractTermsForm.tsx, ContractModal.tsx, ContractTerms.css; settings/ContractTemplates.tsx; sales/sales/SalesPage.tsx; sales/trackings/TrackingDetail.tsx
- What: the deal contract window and the contract-template editor now fill the screen (up to 1760px, 20px margins; 470px summary column). Sections are steps (ContractSteps + Sec id/summary): one open at a time, "Continue" opens the next, done ones fold to a one-line summary with a check; a saved contract/template opens with everything folded. Deal: Includes · Length · Signed/grace/start · Payment · Discounts · Invoicing+increments+renewal. Template: What it is · Lengths · Ways to pay · Grace · Invoicing · Increments · Renewal · Discounts. A "calm pass" block at the end of ContractTerms.css desaturates everything (soft tints, outlined selection instead of dark fills, white summary hero, softer timeline). Deals board/list: moving a deal into a loss phase (drag on the board, stage change, or bulk "Lost") now opens the same "Why was it lost?" window as the deal page (LossReasonModal exported from TrackingDetail; bulk asks once for all); the modal also picks up reasons that load after it opens.
- Tags: PORT? (Base's SalesPage board has the same gap on lost)
- Deploy: none

### 2026-11-12 09:40 · Enterprise · Contracts: signed → grace period → start, payment plan timeline, client page, custom confirms
- Files: sales/extras/contractsApi.ts, ContractPlan.tsx (new), ContractConfirm.tsx (new), ContractClientList.tsx (new), ContractSummary.tsx, ContractModal.tsx, ContractTermsForm.tsx, ContractTerms.css; settings/ContractTemplates.tsx; sales/trackings/TrackingDetail.tsx; clients/ClientWorkspace.tsx
- What: a contract now has a signing day and a grace period (data.signed, data.grace; template config.grace = default grace) — it starts at signed + grace unless a start is set by hand (contractDates()). Figures carry signed/graceDays, each invoice's covered period (from/to), and the renewal (invoice date, due, notice-by, until, estimated amount). New ContractPlan: a timeline (signed · grace hatched · start · paid periods · invoice pins · notice-by · renewal) + milestone chips + payment-plan table (sent / next / later + renewal invoice). Deal contract window: step 3 is Signed → Grace period → Starts boxes; summary shows the timeline and the payment plan. Deal calculator: empty Contracts group offers template tiles; contract cards show dates (signed/grace/starts/renews), a compact timeline and the next invoice. Client page › Contract tab: "Signed contracts" — each won deal's contract with state (in grace / running…), dates, timeline, products and its payment plan (loadContractsForDeals). Contract windows (template + deal): Esc / × / backdrop / Cancel with unsaved changes and Delete/Remove ask in our own dialog (no window.confirm); Esc closes the dialog first, leaves open pickers alone.
- Tags: PORT? (Base has no contracts)
- Deploy: none (no SQL — data lives in tracking_contracts.data / contract_templates.config jsonb)

### 2026-11-12 07:20 · Enterprise · Deal page cards: a minimum size when opened, room under the last thing
- Files: sales/trackings/TrackingDetail.tsx, sales/sales/SalesPage.css
- What: an opened deal card (not a headline, not collapsed) is never shorter than its minimum (DK_OPEN_MIN: activity 470px, calculator 360, probability 300, proposals 230, contacts/details 210, documents 170), or than all it holds when that's less; the saved layout is untouched. Fitting a card to its contents now counts the last item's bottom margin and keeps 18px (DK_FOOT) under it (Documents' drop zone touched the edge). Activity › Meeting: 8px between the meeting name and "What it's about" (the compose box had gap 0).
- Tags: PORT? (Base's deal page has the same board)
- Deploy: none

### 2026-11-12 07:05 · Enterprise · Deals list: row lines run edge to edge again
- Files: sales/sales/SalesPage.css
- What: the sticky "Deal" cell (.dz-who) and its header (.so-th-deal) have a white background that painted over the row's bottom hairline, so lines started at the Stage column. Both now draw the hairline themselves (none on the last row).
- Tags: PORT? (Base has the same sticky .dz-who rule in its SalesPage.css)
- Deploy: none

### 2026-11-12 10:30 · Enterprise · Contracts: redesigned template editor, catalog cards and the deal's contract window
- Files: sales/extras/ContractTermsForm.tsx, ContractSummary.tsx, ContractModal.tsx, ContractTerms.css, contractsApi.ts; settings/ContractTemplates.tsx; sales/trackings/TrackingDetail.tsx
- What: Settings › Catalog › Contracts cards now show a length ladder with discounts, ways to pay (default starred), invoicing/increments/renewal/fee facts. Template editor: lengths as cards, ways to pay as tiles (toggle, early-payment %, star = default), invoicing as a timeline, increments with a year-by-year bar preview, nicer named-discount rows; live preview on a sample price with an "Every option" matrix (lengths × ways to pay, click to preview). Deal contract window: total pill in the header, numbered steps (includes · length tiles · start · payment tiles · discounts), product cards showing the calculator rows ("10 − 5 incl. = 5 users × 15"), quick-add product chips, fee as its own card, "Fine-tune the terms" fold for invoicing/increments/renewal, clickable option matrix in the summary. Deal calculator contract cards: term/payment chips with discounts, savings, invoice track and next invoice. contractsApi: itemFigure returns calculator rows; new pricingMatrix/termKey.
- Tags: PORT? (Base has no contracts)
- Deploy: none (UI only, no SQL)

### 2026-11-11 18:00 · Enterprise · Won deals: boss / admins / managers can edit them ("Edit anyway")
- Files: src/components/pages/sales/trackings/TrackingDetail.tsx, sales/sales/SalesPage.css
- What: a won deal stays read-only, but next to its "Won" badge a boss, an admin, any `*_manager` (or a superadmin) gets "Edit anyway": it unlocks everything `wonLock` guards (name, phases & dates, close estimates, Details, calculator lines, contracts) while the deal stays won; "Editing a won deal · lock" locks it again (also on leaving the deal or a status change). Lost deals were never locked.
- Tags: PORT? (src/base deal page if it locks won deals)
- Deploy: front only.

### 2026-11-11 17:30 · Enterprise · Contracts, phase 1: contract templates in the catalogue + contracts in the deal calculator
- Files: sql/131_contracts.sql (new, applied), src/components/pages/sales/extras/contractsApi.ts + ContractTermsForm.tsx + ContractSummary.tsx + ContractModal.tsx + ContractTerms.css (new), src/components/pages/settings/ContractTemplates.tsx (new), CatalogPage.tsx, src/components/pages/sales/trackings/TrackingDetail.tsx, src/components/pages/clients/ClientWorkspace.tsx
- What: **Settings › Catalog › Contracts** (tab next to Products / Services): templates with lengths in days/months/years each with its discount, renewal (period + notice), ways to pay (upfront / yearly / 6-monthly / quarterly / monthly, each on/off + early-payment discount, one default), invoicing (N days before it starts/renews, due in N days), yearly increments (% or €, "none if paid upfront"), named commercial discounts (% or €/yr, on by default or not), a fee of its own, products it may include; live preview on a sample price. **Deal › Calculator**: new "Contracts" group above Products (+ Add contract from a template or from scratch; cards with length · payment · products · total / year 1); the contract window holds products priced by their own calculator inputs (tier + inputs, no product discounts/term/increments), its terms (length chips, start date, payment choice…) and the summary (total, list → discounts, each year, invoice dates incl. prepayment and the renewal invoice). Contracts count in the deal's totals (year 1 or whole term by the revenue view). Maths in `contractFigures()` (duration % → payment % → commercial, increments waived when upfront and set so). **Clients › contract card**: services no longer shown or counted (scope, years, services note) — they belong to Services/Projects.
- Next (phase 2): handoff from the deal's contracts, Billing "to bill" from the contract (prepayment dates) instead of licences, reports/pipeline values reading contracts.
- Tags: **DB**, PORT? (src/base catalogue / deal calculator)
- Deploy: 131 applied.

### 2026-11-11 13:40 · Base · Integrations: Google Ads
- files: `pages/settings/Integrations.tsx`, `api/connectedAccounts.ts`, `requests/connected-accounts.index.ts.txt`, `sql/130_connected_google_ads.sql` (new).
- **DB (130)**: `connected_assets.kind` + `gads_customer`. Applied 2026-11-11.
- **Edge function `connected-accounts`** (deployed by Base, now v14): Google logins with service `gads` (scope `…/auth/adwords`) read their Google Ads accounts via Google Ads API **v26** (`customers:listAccessibleCustomers` + GAQL `customer` and last-30-days `metrics.cost_micros / clicks / impressions / conversions`), stored as `gads_customer` (extra: currency, manager, test, cost_30d, clicks_30d, impressions_30d, conversions_30d); "Re-read accounts". Needs secret `GOOGLE_ADS_DEVELOPER_TOKEN` (+ optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID`). Also: Remove on a WhatsApp system-user account no longer revokes that token's app permissions.
- Front: **Google Ads** moved from Coming soon to Available (provider google, service `gads`; "Use here" on a linked Google account adds it); accounts list with spend / clicks / conversions; folding setup guide (developer token, enable API, adwords scope, secrets).
- tags: DB (130)
- deploy: written to the Mac · SQL applied · function deployed · user: developer token secret + push

### 2026-11-11 13:05 · Base · Integrations: errors fade, apps you have look quieter
- files: `pages/settings/Integrations.tsx` / `.css`.
- An error under an app ("The sign-in window was closed", …) clears itself after ~9 s and as soon as any account gets connected. In **Available**, apps you already have (count badge) are desaturated and dimmed; full colour on hover / when open.
- deploy: front only.

### 2026-11-11 13:40 · Enterprise · Upsell / cross-sell pipelines ↔ client upsells (one shared id)
- Files: sql/129_expansion_pipelines.sql (new), src/components/pages/settings/pipelineApi.ts, PipelinePage.tsx / .css, src/components/pages/clients/useClientsData.ts, ClientsPage.tsx / .css
- What: Settings › Pipelines: two new switches next to Renewals — **Upsell** / **Cross-sell** (one per pipeline; pill in the bar); marking one links the client deals already in it (`expansion_backfill`). DB does the linking (works from any page/import): a deal created in / moved into such a pipeline for a company that is a client → a `client_upsells` row (motion, title = deal name, value = its products per year, status proposal/won/lost, owner = deal owner); an upsell / cross-sell created in Clients or Customer success → its deal in the first pipeline of that kind (first open phase, its product, owner as deal owner) and `deal_id` set. Then the deal leads: won/lost/reopened, renamed, products → value, owner. Upsell editor: Upsell | Cross-sell choice (locked once it has a deal) + a line saying where its deal goes; cards show "Cross-sell"; the CS matrix marks a product they already have as upsell, a new one as cross-sell. `convertUpsellToDeal` prefers the pipeline of its kind.
- Tags: **DB**, PORT? (src/base clients upsells: `motion` defaults to upsell, nothing breaks)
- Deploy: SQL 129 for the user to run in the SQL editor (apply_migration timed out on a confirmation).

### 2026-11-11 12:45 · Base · Integrations: one WhatsApp form (access token + account ID)
- files: `pages/settings/Integrations.tsx` / `.css`.
- The "account ID" field on a Meta sign-in card is gone (that token can never read WhatsApp accounts); the card points to the single form, now "Connect with an access token": the API-setup token to try it (~24 h) or a system user's permanent token. (`wa_add` stays in the function, unused by the UI.)
- deploy: front only.

### 2026-11-11 12:30 · Base · Integrations: WhatsApp with a system-user token
- files: `pages/settings/Integrations.tsx` / `.css`, `api/connectedAccounts.ts` (`connectWhatsAppToken`), `requests/connected-accounts.index.ts.txt`.
- **Edge function `connected-accounts`** (deployed by Base, now v13): action `wa_token { token, wabaId }` — a system-user token of the business (Business settings › System users; WhatsApp account assigned, whatsapp_business_management + _messaging) is checked with Meta, stored server-side as a `meta` account `whatsapp:<waba>` with services [whatsapp], numbers read + app subscribed. Reason: Facebook Login for Business configurations don't offer WhatsApp accounts as an asset, so the sign-in token can't read the WhatsApp account. Known gap: "Remove" on such an account calls DELETE /me/permissions (would revoke the system user's app permissions) — to skip for `scopes = system_user` in the next function change.
- Front: WhatsApp panel → fold "Connect with a system user token" (4 steps + token / account ID form; open while no number is connected).
- deploy: written to the Mac · function deployed · user to push

### 2026-11-11 11:05 · Base · Integrations: WhatsApp account by ID + tidier panel
- files: `pages/settings/Integrations.tsx` / `.css`, `api/connectedAccounts.ts` (`addWhatsAppAccount`), `requests/connected-accounts.index.ts.txt`.
- **Edge function `connected-accounts`** (deployed by Base, now v12): action `wa_add { id, wabaId }` — reads a WhatsApp Business account's numbers by its ID with the Meta login's token (Meta's test WhatsApp account isn't owned by the login's business, so discovery finds nothing); such accounts are kept on every re-read (`extra.manual`).
- Front: a WhatsApp card with no numbers shows "Paste the WhatsApp Business account ID" + Add. Setup guides now fold away in a "How to set it up" row (open only when sign-in isn't set up yet); the "second Facebook login" hint is gone.
- deploy: written to the Mac · function deployed · user to push

### 2026-11-11 11:40 · Enterprise · Management settings redesigned + notifications for new handoffs
- Files: sql/128_handoff_alerts.sql (new, applied), src/components/pages/management/HandoffAlertsSettings.tsx + .css (new), ManagementPage.tsx, src/components/pages/calendar/CalendarSettingsModal.tsx / .css, src/components/pages/homepage/HomePage.tsx
- What: **Management › Settings** is one fixed-size window (1240×860 max) with the sections down a dark side rail — Notifications · Working hours · Billing cutoffs · Security — and a white header (title + what it's for) over a scrolling body; no more modal resizing per tab, content glued to the header or clipped bottoms (calendar mode of CalendarSettingsModal unchanged: the new shell is `managementMode` only). **Notifications**: "Every handoff" + "Only handoffs going to <service pipeline>" (the pipelines sales hands over to, with where they come from), people as chips + "+ Add someone" (custom Select); autosaves to `billing_settings.handoff_notify`. DB trigger notifies them on each new handoff (`handoff_new`, body "<destination> · <value> €"; the sender isn't told; never blocks a handoff). Home bell: "handed over a won deal", Projects tab, opens Management › Incoming. Class prefix `hfa-` (`.ha-*` is taken by HomePage.css).
- Tags: **DB**, PORT? (src/base management settings if it has the same modal)
- Deploy: 128 applied.

### 2026-11-11 10:50 · Base · Integrations: sign-in popup no longer renews the session; 401 → renew once
- files: `api/connectedAccounts.ts`.
- The sign-in popup (it loads the app at /settings) now stops Supabase's auto-refresh before closing, so two windows don't renew the same session at once ("Refresh Token Not Found" → "Not authenticated" seen on nextcrm.atebiz.com). Calls to `connected-accounts` that get 401 renew the session once and retry; otherwise "Your session ended — reload the page and sign in again."
- deploy: front only.

### 2026-11-11 10:30 · Base · Integrations: WhatsApp Business (Cloud API) + collapsed account cards + ⓘ "What it does"
- files: `pages/settings/Integrations.tsx` / `.css`, `api/connectedAccounts.ts` (`sendWhatsApp`, `listWhatsAppMessages`), `requests/connected-accounts.index.ts.txt`, `requests/whatsapp-webhook.index.ts.txt` (new), `sql/127_whatsapp.sql` (new).
- **DB (127)**: `connected_assets.kind` + `whatsapp_number` (external_id = phone_number_id; extra waba_id / display_phone_number / quality_rating / status); new `whatsapp_messages` (in / out per number, status, error, payload; RLS: the number's owner reads; written only by edge functions). Applied 2026-11-11.
- **Edge function `connected-accounts`** (deployed by Base, now v10): Meta logins with service `whatsapp` read the WhatsApp Business accounts the login shares (`debug_token` granular scopes, else the businesses' own) → their numbers, and subscribe the app to each (`/{waba}/subscribed_apps`); new action `wa_send { assetId, to, text | template }` (stores the message as `out`).
- **New edge function `whatsapp-webhook`** (verify_jwt **false**; deployed by Base, v1): Meta's GET check against secret `WHATSAPP_VERIFY_TOKEN`; POST checked with `X-Hub-Signature-256` (META_APP_SECRET); incoming messages → `whatsapp_messages` (in), statuses update sent / delivered / read / failed. Enterprise: it's yours to adopt — matching is by `connected_assets` (kind whatsapp_number).
- Front: **WhatsApp Business** moved from Coming soon to Available (same Meta app; `VITE_META_CONFIG_ID` must include WhatsApp accounts). Its account card lists the numbers, a "Send a test" (hello_world template or free text inside 24 h) and the latest messages. Setup guide (use case, number, webhook URL + verify token, configuration).
- UX (all apps): account cards start **collapsed** (name, one-line summary, status) and expand smoothly; a just-connected one opens. "What it does" section removed → an **ⓘ next to the app name** shows it on hover / focus, animated.
- tags: DB (127) · new edge function
- deploy: written to the Mac · SQL applied · both functions deployed · user: set WHATSAPP_VERIFY_TOKEN, Meta webhook, commit/push

### 2026-11-10 16:55 · Enterprise · Reports: owned reports shared with people
- Files: sql/126_report_sharing.sql (new), src/components/pages/sales/extras/ReportShare.tsx (new), SalesReport.tsx / .css, src/components/pages/homepage/HomePage.tsx
- What: a report has one owner. The report bar's share button (build and view) opens "Share this report": the owner, "Everyone in the team" (the old `shared`), and People — add anyone (custom Select), each "Can view" / "Can edit" / "Make owner" (hands it over; you stay as editor) / "Remove". Applies at once for a saved report (saved with it for a new one). Only the owner changes it (others see it read-only; DB guard trigger enforces it). People who can edit save in place; viewers save a copy (a copy starts unshared). Sidebar: "· team + 2", "· shared with 3", "· from Marta · can edit". Notifications: whoever is added / made owner gets `report_shared` / `report_owner` (Home bell, new "Reports" tab) that opens `/reports?report=<id>`. Before 126 is run: only the team switch works and the menu says so.
- Tags: **DB**, PORT? (src/base has no Reports page)
- Deploy: SQL 126 for the user to run in the SQL editor (apply_migration timed out on a confirmation).

### 2026-11-10 17:00 · Base · Integrations: Mailrelay (e-mail marketing, API key)
- files: `pages/settings/Integrations.tsx` / `.css`, `api/connectedAccounts.ts` (`connectMailrelay`), `requests/connected-accounts.index.ts.txt`, `sql/125_connected_mailrelay.sql` (new).
- **DB (125)**: `connected_accounts.provider` + `mailrelay`; `connected_assets.kind` + `mailrelay_group`. Applied 2026-11-10.
- **Edge function `connected-accounts` v7** (deployed by Base): action `connect_key { provider: "mailrelay", account, apiKey }` — address normalised to `<name>.ipzmarketing.com` (only Mailrelay hosts), key checked with `GET /api/v1/ping` (header `X-AUTH-TOKEN`), stored in `connected_account_tokens.access_token` (service role only; `token` refuses to return it), account email = the address; groups read into `connected_assets` (`/api/v1/groups`, subscribers count when given). `check` pings; `assets_sync` re-reads groups.
- Front: **Mailrelay** in Available (no sign-in window): the panel has a form — Account address (`yourcompany` + `.ipzmarketing.com`) + API key (hidden, Show) → Connect; a 3-step "where to find the key" guide; accounts show their groups, Check now, Re-read groups, Remove; "Add another account" opens the form again.
- tags: DB (125)
- deploy: written to the Mac · SQL applied · edge function v7 deployed · user to commit/push

### 2026-11-10 14:30 · Base · Integrations: LinkedIn (profile now, company pages when approved) — restored (an Enterprise write dropped it)
- files: `pages/settings/Integrations.tsx`, `api/connectedAccounts.ts`, `requests/connected-accounts.index.ts.txt`, `sql/124_connected_linkedin.sql` (new).
- **DB (124)**: `connected_accounts.provider` + `linkedin`; `connected_assets.kind` + `linkedin_org`. Applied 2026-11-10.
- **Edge function `connected-accounts` v6**: provider `linkedin` — code → token (no PKCE), `/v2/userinfo`, company pages via `/rest/organizationAcls` + `/rest/organizations/{id}` (LinkedIn-Version 202610), refresh only if LinkedIn gives one, disconnect revokes. Secrets `LINKEDIN_CLIENT_ID` / `_SECRET` (+ optional `LINKEDIN_PAGES_*`).
- Front: LinkedIn in Available; `VITE_LINKEDIN_CLIENT_ID`, `VITE_LINKEDIN_PAGES=1` (+ `VITE_LINKEDIN_PAGES_CLIENT_ID`); setup guide. "LinkedIn Ads" stays in Coming soon.
- tags: DB (124)

### 2026-11-10 16:10 · Enterprise · Deal contract: grace period (signed on one day, starts on another)
- Files: src/components/pages/sales/trackings/HandoffClientForm.tsx / .css, sales/sales/salesApi.ts, sales/trackings/TrackingDetail.tsx, clients/ClientWorkspace.tsx / .css
- What: the contract panel's "Dates & term" has 4 boxes: Sign date · **Grace period** (− N months +) · Contract start · Term. The grace moves the start (sign date + N months; changing the sign date moves the start with it); picking a start by hand sets the grace it makes (or "N days" when it isn't whole months); "Start on the sign date" clears it. A note under them: "Signed X → starts Y — the term, contract years, yearly prices and renewal count from the start". `ContractTerms.graceMonths` (new, optional; `contractStart` stays the source of truth and is saved only when it differs from the sign date). Handoff: the client's new signed products get `start_date` = the contract start (was the sign date). Client page contract card: subtitle "Signed … · 3-month grace", status "Grace period · starts …" until it starts, and a "Starts" fact with the grace chip in the order form.
- Tags: PORT? (src/base contract panel if it has Dates & term)
- Deploy: front only.

### 2026-11-10 15:30 · Enterprise · Reports: a customizable Home first
- Files: src/components/pages/sales/extras/ReportsHome.tsx + ReportsHome.css (new), SalesReport.tsx
- What: Reports now opens on **Home** (tabs Home | New report; the hero's "New report" and every "back" go there / to the starts). Home = "Jump back in" chips (your 6 latest reports) + a board of widgets, each read live from a saved report (yours or shared with you) or a ready-made one: **its figures**, **one of its charts** or **its first rows** (3/6/10, the report's sort), with the report's own rules and period. "Customize": add (report + what to show), drag to reorder, width ⅓ / ½ / whole, change what it shows, remove, Reset. Kept per user in `profiles.prefs.reports_home` ({v:1, widgets}); with nothing saved yet a starter board (your latest report's figures + first charts, else ready-made ones). Each part of the CRM is read once for all its widgets (loadCrmData cache); "Refresh" reads again. Widgets compute synchronously per report period (setReportPeriod), then reset to the default.
- Tags: PORT? (src/base has no Reports page)
- Deploy: front only.

### 2026-11-10 14:45 · Enterprise · Clients: one start / renewal rule everywhere (contract dates count, not only projects)
- Files: src/components/pages/clients/ClientWorkspace.tsx, ClientsPage.tsx, src/components/pages/sales/extras/salesReportEngine.ts
- What: new exports in ClientWorkspace — `lineStartOf(l, ct)` (start → signing → the contract's start → its sign date), `termWith(l, ct)` (a product's term filled in from its contract's years / auto-renew when it has none) and `renewalOf(l, ct)` (own term → contract's term → a subscription's yearly anniversary). Client page: "Client since" (Company card + facts) and "First kick-off" (shown as "Started" with no projects) now count signed products and contracts, not only projects — 26 licence-only clients showed them empty; "Next renewal" uses the contract when the product has no term ("no term on file" before); a product row's term, Signed, Starts, Term, Renews fall back to its contract. Clients list: renewal + "Client since" read the contracts' terms (trackings.contract_terms loaded with the lines); Customer success's `csRenewalOf` is now `renewalOf`. Reports: client Next renewal / Contract starts / First signed use the same fallbacks.
- Tags: PORT? (src/base clients: "Client since" from projects only)
- Deploy: front only.

### 2026-11-10 13:55 · Base · Integrations: Meta (Facebook + Instagram + Ads in one sign-in), Facebook and Instagram separately
- files: `pages/settings/Integrations.tsx` / `.css`, `api/connectedAccounts.ts`, `requests/connected-accounts.index.ts.txt`, `sql/123_connected_meta.sql` (new).
- **DB (123)**: `connected_accounts.provider` may be `meta`; new `connected_assets` (Facebook pages / Instagram professional accounts / ad accounts a Meta login reaches; RLS own select) + `connected_asset_tokens` (page tokens, service role only). Applied 2026-11-10 (the Supabase migration is named `121_connected_meta`; renumbered to 123 because Enterprise took 121/122 meanwhile).
- **Edge function `connected-accounts` v5** (deployed by Base): provider `meta` — Facebook Login code → long-lived user token (≈60 days, no refresh: "Check now" verifies, signing in again renews), reads `/me/accounts` (pages + linked `instagram_business_account`) and `/me/adaccounts`, stores them with page tokens; new action `assets_sync`; disconnect revokes (`DELETE /me/permissions`). Graph API v26.0. Secrets `META_APP_ID`, `META_APP_SECRET`.
- Front: Available now has **Meta** (asks facebook + instagram + ads), **Facebook** (pages only) and **Instagram** (IG only) — one Meta login shows under each app it was granted for; "Use here" re-asks (auth_type=rerequest). Account cards list the pages / Instagram accounts (@user, followers) / ad accounts with pictures; "Re-read pages". `VITE_META_APP_ID` (+ optional `VITE_META_CONFIG_ID` for Facebook Login for Business configurations). Meta setup guide in the panel until the App ID exists. Meta and Instagram left Coming soon; Messenger stays there.
- tags: DB (123)
- deploy: written to the Mac · SQL applied · edge function deployed · user to commit

### 2026-11-10 14:20 · Enterprise · Clients: an upsell inside an existing contract (not a contract of its own)
- Files: sql/122_upsell_in_contract.sql, src/components/pages/clients/ClientWorkspace.tsx, ClientsPage.tsx, src/components/pages/sales/sales/salesApi.ts
- What: a signed product's contract is `contract_tracking_id || tracking_id` (`contractKeyOf`). Three ways in: (1) a contract card (a deal's own products) has "Upsell into… <contract>" → all its products join that contract and the upsell deal stops counting as a contract (also when it had an order form); (2) editing a signed product: "Contract" = its own / Upsell into <contract> (back to its own too); (3) "Add product" by hand: "Contract" = a contract of its own / Upsell into <contract> (`saveClientProducts` takes `contractTrackingId`). In the contract: its dates, term and renewal come from its own products; an upsell counts from the contract year it started in (`yearOffsetOf`), shows in the scope as "Upsell · <deal> · signed <date>", and the product row says "upsell in <contract>". Customer success renewals follow the contract the product is in.
- Tags: **DB**, PORT? (src/base clients if it groups contracts by deal)
- Deploy: 122 applied.

### 2026-11-10 13:40 · Enterprise · Clients: change a signed product's deal-calculator values (with its own right)
- Files: src/components/framework/pageAccess.tsx, src/components/pages/clients/ClientWorkspace.tsx/.css
- What: new client editing right **"Deal calculator"** (`ClientEditAction` "valuation", Settings › Client page › Editing rights, default: managers; bosses / superadmins always) — who may change the calculator figures a signed product was valued with on its deal. Client › Contracts › Signed products: a product that came from a deal and whose catalogue product has a calculator shows a calculator button (beside edit). It opens the deal's own LineCalcModal on that deal's tracking_products line (tier, calculator values, commitment, term, increases, partner): "Apply" saves it on the deal (`updateTrackingProduct`) and reprices the client's line like the handover does (`lineBreakdown`: price, quantity, period, term, schedule, breakdown rows / years / partnerYears, `breakdown.revalued` = when) — the line says "revalued <date>" and a note shows the new first-year figure. Same product twice on one deal: the line's place among its twins picks the deal line. Actions column 100px when the button shows (`.cw-pt.has-calc`).
- Tags: PORT? (src/base Settings › Editing rights + client products if Base has calculators)
- Deploy: frontend only.

### 2026-11-10 12:50 · Base · Integrations: one Google sign-in links Gmail and Google Calendar
- files: `pages/settings/Integrations.tsx` / `.css`, `api/connectedAccounts.ts`.
- Connecting Gmail or Google Calendar now asks for both (mail + calendar) in one consent, so the account shows under both apps (Outlook already did both). A Google account linked for only one of them shows in the other app's panel with "Use here" — it re-asks consent for that address only (`login_hint`, no account picker).
- `addAccount(provider, services, { loginHint })`.
- First real Gmail account connected 2026-11-10 (mail + calendar, refresh token stored).
- deploy: written to the Mac · user to commit

### 2026-11-10 13:00 · Enterprise · Deal Details: Yes / No fields redesigned
- Files: src/components/pages/sales/extras/FieldInput.tsx, TrackingFields.css
- What: the yes/no custom fields (Details card on a deal, New deal form) were a small grey pill narrower than every other box. Now as wide and tall (40px) as the other controls, two halves with a ✓ / ✕ sign: Yes picked = green, No picked = white with red, nothing picked = not answered (clicking the picked one again clears it, hinted in its tooltip). Classes `.tfi-yn button.is-yes / .is-no`.
- Tags: PORT? (src/base has its own FieldInput if the Base deals use custom fields)
- Deploy: frontend only.

### 2026-11-10 12:40 · Enterprise · Clients: churn on a future date, the calendar no longer closes the churn form, rows keep their place
- Files: sql/121_client_churn_end.sql, src/components/pages/clients/ClientWorkspace.tsx/.css, useClientsData.ts, ClientsPage.tsx
- What: (1) the error "client_products_status_chk": marking churned + "stop its running products" wrote status 'churned' to client_products, which the check refuses → now 'cancelled' (and the check also allows paused / ended, offered by the product status picker). (2) The churn date has no max any more: a later day is the contract's end — "Contract ends on", "Stays active until then and turns churned on that day", button "Churn on that day"; the client stays **active** until then (status 'churned' + future churned_at in the DB; useClientsData maps it to active until the day), chip "Leaving" (list) / "Leaves 15 Jan" in amber, menu shows "On <date> (contract end) · change" and "Active — keep them: cancel the churn"; its running products get `ends_on` = that day and `isActive()` stops counting them from then (121). Active again clears ends_on. (3) Changing month in the date picker closed the churn form: its outside-click ignored `.dp-layer` but not `.dp-pop` → fixed. (4) Rows keep their place after changing the status (`stay` map in ClientList, until the list is filtered / sorted / searched again) instead of the churned one jumping to the bottom.
- Tags: **DB**, PORT? (src/base clients if it has the status picker)
- Deploy: 121 applied.

### 2026-11-09 23:30 · Enterprise · List column headers: sort + filter menu on every column, centred columns
- Files: src/components/framework/ColumnHead.tsx + ColumnHead.css (new); pages/sales/sales/SalesPage.tsx/.css (deals list), pages/contacts/ContactsPage.tsx/.css, pages/companies/CompaniesPage.tsx/.css, pages/clients/ClientsPage.tsx/.css (list layout), pages/projects/ProjectsView.tsx + ProjectsPage.css
- What: clicking any column header opens a menu (portalled, placed under the header): **Sort** (A→Z / Z→A, smallest / largest, oldest / newest; "keep the current sort and sort by this next") and **Show**: tick the values to keep for select / multi fields (search, Select all, "Only these N" after a search, "No value", a count per value when the rows are loaded), min / max for figures (the list's lowest / highest as hints), presets + from / to for dates, "contains" + has a value / empty for text, all / yes / no for booleans. A column can filter on several fields (Deals › Stage: status, pipeline, stage; Potential value / Expected close; Projects › Dates: kick-off and end…). It writes the list's view (`FView` conds with id `h:<field>:…` and `view.sort`), so header picks show as chips, combine with the Filters panel, survive reloads and are **saved with views**; in server mode (contacts / companies) they go to the RPC like any condition. Header filters always combine with "and". Deals keep their own sort codes for the built-in columns (`sorts` prop) and every other column now sorts by its field (`applyView` on `dview.sort` when it isn't a `~code`); the old header range popover (SalesRanges) is gone from the header (the Filters panel ranges stay). New deal fields for the plain columns that had none: phaseProb, repClose, mgrClose, coLegal, coVat, ctPosition, ctAll. Projects got a stored view (`np-projects-view`) for its headers + FilterChips; the toolbar sort reads "By a column" when a header sort is on. Every column but the first (the record itself) is centred — header label and cells — on all five lists; the sort arrows hang to the right of a centred label.
- Tags: PORT? (src/base lists use the same CompaniesPage engine: copy framework/ColumnHead.* and swap SortHead for ColumnHead with the column's field)
- Deploy: frontend only.

### 2026-11-09 22:10 · Base · Integrations: three lists + detail that pushes the rest; account facts; Google setup guide
- files: `pages/settings/Integrations.tsx` / `.css`, `api/connectedAccounts.ts`, `sql/120_my_outlook_connection.sql` (new).
- Layout: three lists side by side — **Connected** (apps you linked, N accounts, status dot) · **Available** (Gmail, Google Calendar, Outlook) · **Coming soon** (12, requested ones ticked). Clicking an app opens a detail panel right after its list: it grows 0 → 440px and pushes the other lists right (they get narrower); Esc / × closes. Connected app → every account with Connected on, Last active, Last mail read (cs_mailbox_sync / ticket_mailboxes), Used for, status, Check now (edge `check`), Remove; then Add another account. Google, while `VITE_GOOGLE_CLIENT_ID` is missing → an 8-step setup guide with copyable origins / redirect URI. Coming soon → what it will do + Notify me. New account: logo flies from the panel into the Connected list.
- `connectedAccounts.ts`: `checkAccount`, `myOutlookConnection` (RPC), `lastMailReads`; list now reads `updated_at`.
- tags: DB (120)
- deploy: written to the Mac · SQL 120 applied 2026-11-09 · user to commit

### 2026-11-09 21:20 · Base · Integrations redesigned (brand cards) + edge function connected-accounts deployed
- files: `pages/settings/Integrations.tsx` / `.css`, `pages/settings/brandIcons.ts`, `requests/connected-accounts.index.ts.txt`.
- New layout, top to bottom: **Connected** (one brand-tinted card per account: logo, app, address, Mail / Calendar chips, status dot, remove on hover) · **Available** (Gmail, Google Calendar, Outlook as big cards in their brand colour, button "Connect Outlook" / "Add another account", "N connected" badge) · **Coming soon** (light tiles, click to request — bell / tick). Search moved into the header. The logo still flies into its new card on connect.
- Real Outlook and LinkedIn marks (Simple Icons v9.21, CC0 — the last release that had them).
- **Edge function `connected-accounts` deployed by Base** (v1, verify_jwt on) from `requests/connected-accounts.index.ts.txt` — a new function, no existing one touched. Extra Outlook accounts work now (MS secrets exist). Gmail / Google Calendar still need `VITE_GOOGLE_CLIENT_ID` (front) + `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Supabase secrets). §8 request updated: Enterprise only has to adopt the source into `supabase/functions/` if it wants it there.
- deploy: written to the Mac · edge function deployed · user to commit

### 2026-11-09 16:10 · Base · Integrations in two columns: Connected (left) · Add an app (right)
- files: `pages/settings/Integrations.tsx` / `.css`.
- Left panel "Connected" (sticky): one compact row per account and app (logo, address, app · Mail / Calendar, status dot; remove appears on hover, with Remove / Keep). Empty state when nothing is linked.
- Right panel "Add an app": search, "Available now" (Gmail, Google Calendar, Outlook — Connect / Another, "N connected" badge, errors inline) and "Coming soon" (Notify me) as compact rows in a 2–3 column grid.
- Connecting flies the app's logo from the right row into its new row on the left (Web Animations clone, arc + scale), and the new row lands with a green flash.
- deploy: written to the Mac · user to commit

### 2026-11-09 15:30 · Base · Integrations: real Gmail / Google Calendar / Outlook accounts, several each, real logos
- files: `api/connectedAccounts.ts` (new), `pages/settings/Integrations.tsx` / `.css`, `pages/settings/brandIcons.ts` (new), `pages/settings/SettingsPage.tsx`, `BaseApp.tsx`, `sql/119_connected_accounts.sql` (new), `requests/connected-accounts.index.ts.txt` (new — edge function for Enterprise to deploy, see §8).
- Mail & calendar cards (Gmail, Google Calendar, Microsoft Outlook) list each connected account (address, Mail / Calendar, remove with confirm) and "Add another account". Sign-in opens in a popup (PKCE, `prompt=select_account`), comes back to `/settings?state=acc.…`, caught by `connectedAccounts.ts` (imported in BaseApp so the popup closes itself); the code goes to the edge function `connected-accounts`, which stores the account. The first Outlook is still the existing connection (calendar + mail in one go); more Outlooks go to `connected_accounts`. No invoice wording here any more — Billing will pick from the connected accounts later.
- Logos: Simple Icons path data (CC0) in `brandIcons.ts` for Gmail, Google Calendar, WhatsApp, Messenger, Meta, Instagram, TikTok, Google Ads, YouTube, X, Google Analytics, Google. Outlook and LinkedIn aren't in Simple Icons → lettered tile.
- Until SQL 119, the edge function and `VITE_GOOGLE_CLIENT_ID` exist, Gmail / Google Calendar show "Needs setup" and Add is off; nothing breaks.
- tags: DB (119) · IDEA→ENT (multi-account mail for Enterprise too)
- deploy: written to the Mac · SQL 119 applied in Supabase 2026-11-09 · edge function: request in §8 · user to commit

### 2026-11-09 14:15 · Base · Settings: Integrations is its own page (Outlook moved out of Interface)
- New `pages/settings/Integrations.tsx` / `.css` (prefix `.ig-`), view `"integrations"` in `SettingsPage.tsx`, its own tile in "Just you" next to Interface. Groups: Mail & calendar (Outlook — live: calendar sync + mailbox for invoices, same handlers as before; Gmail, Google Calendar), Messaging (WhatsApp Business, Messenger & Instagram DMs), Social & ads (Meta, LinkedIn, TikTok, Google Ads, YouTube, X), Website & analytics (Google Analytics, Google Business Profile, your website forms). Not-yet-built apps show "Soon" + "Notify me" (remembered in localStorage `next.base.integrations.want`) and a "What it brings" pop-up.
- Interface keeps only menu labels + toolbar order (tile text updated). Coming back from Microsoft now opens Integrations instead of Interface.

### 2026-11-09 14:10 · Enterprise · Summoned colleagues: "Not billable" option, and a popup on accepting it
- Files: src/components/pages/calendar/BookingModal.tsx/.css, InviteBillAsk.tsx/.css, invitesApi.ts, InvitesTray.tsx
- What: People step, per summoned colleague on client work (any role): "I set it" (a figure) / "They decide" (a suggestion) / **"Not billable"** (= I set it at 0, the figure field hides; "They see it when they accept"). Picking "I set it" again from 0 puts back the entry's figure. Accepting any invite to client work (`project_id` or `client_id`) now always opens the billing popup (`asksBill`): they choose ("they"), or see what the organiser set — the figure, or "Not billable for you" (new `.iba-fixed.is-free`); title "<organiser> set what you bill". The tray card says "Not billable for you — <organiser> set it" on client work. Internal time still accepts straight away. No DB change (bill_mode stays fixed|they; 0 = not billable).
- Tags: PORT? (src/base calendar has the same invites if it was ported from 115)
- Deploy: frontend only.

### 2026-11-09 02:40 · Enterprise · Calendar: client and company logos in the meeting pickers
- Files: src/components/pages/calendar/BookingModal.tsx, SalesCalendar.tsx, SalesCalendar.css
- What: Log work / meeting wizard › "Client & project": the client list and the chosen client show the company logo (`ClientLogo` from ClientWorkspace, from the company's website; initials until it loads) instead of two letters. Sales calendar › New meeting: the Company picker (and "Link to a company") shows each company's logo in the list and in the closed field (`Picker` prop `logos`, `.sc-pick-co` / `.sc-pick-logo`).
- Tags: PORT? (src/base/pages/calendar has the same BookingModal client list)
- Deploy: frontend only.

### 2026-11-09 02:15 · Base · Products & Services: collapse and delete buttons apart
- `pages/settings/BaseCatalog.css`: `.bc-hd-tools` gets a 14px gap and a thin divider between the collapse (chevron) and delete buttons on an open product card.

### 2026-11-09 02:15 · Enterprise · Build project: the whole team is notified
- Files: sql/118_project_team_alerts.sql, src/components/pages/homepage/HomePage.tsx, HomePage.css
- What: when a project is created (Incoming › Build project) everyone on its team gets a notification in the Home bell (live, through the existing user_alerts realtime): "<who> put you on a new project · <Client> · <service> · Kick-off <date>". Someone added later to an existing project's team gets "added you to the project". The person who builds it isn't notified about themselves. New "Projects" tab in the notifications window, folder icon in teal (`.hn-item.is-proj`); clicking opens the client's page (`/clients?client=…`).
- Tags: **DB**, PORT? (Base's home bell would need the same kinds: project_new / project_added, ref_type project)
- Deploy: 118 applied; frontend only otherwise.

### 2026-11-09 01:50 · Enterprise · Number fields: you can type 0, 0.5, 1.50 as you mean them
- Files: src/components/framework/NumInput.tsx (new); every `<input type="number">` in src/components (96 fields, 30 files: LineCalcModal, Catalog, Handoff forms, IncomingConvertModal (Build project), Billing, Bonus plan, Calendar settings, CS editor / CsFlow, Companies, Contacts, Marketing, Proposal templates, Superadmin…) now `<NumInput type="number" …>`; ClientWorkspace's yearly-increase field (text, `inc ? String(inc) : ""`) too.
- What: fields that show 0 as empty (`value={n === 0 ? "" : n}`, `n || ""`) wiped the "0" typed before "0.5", and text fields that turn the text into a number lost "0." / "1.50". NumInput shows exactly what's typed while the field has the focus (onChange still fires on every key as before), shows the parent's value again only if it really differs (clamped / rounded) and on blur. Same props as <input>; type="number" kept (CSS on `input[type="number"]` unchanged). A text NumInput takes a comma as the decimal point and steps with ↑ / ↓. Time fields, postal codes, phone extensions and string-state decimal text fields left as they were.
- Tags: **PORT?** — src/base has ~77 `<input type="number">` with the same patterns: copy framework/NumInput.tsx and swap the tags.
- Deploy: frontend only.

### 2026-11-09 01:45 · Base · Products & Services: smooth expand, no "+ Product / + Service" in the columns
- New `pages/settings/Smooth.tsx`: a wrapper that glides its own height (ResizeObserver, 0.5s ease-out) whenever its content changes size; clips overflow only while moving so shadows stay.
- `BaseCatalog.tsx`: each product (row ↔ open card) sits in `<Smooth>`, so opening and folding grows/shrinks instead of jumping; the column headers lose their "+ Product" / "+ Service" buttons (the top-right "New" does it; empty columns still show "Add your first …").
- `BaseServices.tsx`: the service row's steps unfold inside `<Smooth>`. `BaseCatalog.css`: `.bc-smooth`, softer fade (no slide) for the opening card and the steps.

### 2026-11-09 00:50 · Base · Organization: Add button appears as you type; more room for people
- `pages/settings/OrgSteps.tsx`: `NewLine` (new department) — the hint text under it is gone (only errors show there); the "Add" button is hidden until something is typed, then slides/pops in (`.os-new-go.is-shown`).
- `OrgSteps.css`: step 2 (People) — the people list gets the space (min 220px, grows); the "Pages it opens / Its levels" card is capped at 30% of the panel and scrolls on its own (thin scrollbar, fade at the bottom).

### 2026-11-08 14:20 · Base · Growth restyled to the app's look (Billing / Deals)
- `pages/growth/GrowthPage.tsx` / `.css` only. The first version had its own minimal style; now it uses the Base visual language: Billing's dark green sticky header (`.gr-head`, same gradient, dots and sheen) with the pill switch (icons; a divider between Attract and Keep; Customers shows the at-risk count), glass brand switch, Preview chip, emerald "New campaign".
- KPI cards = Billing's `.bz-kpi` (coloured icon tile, count badge, 34px figure, area spark, share bar) on Overview, Ads (new row: spent, leads from ads, cost per lead, return) and Customers (Healthy / Watch / At risk, click to filter). Chips with dot + count, tables with the `#f7fbf9` uppercase head, pastel square avatars and status pills. Side panels get the invoice modal's dark header; AI blocks and the wallet are dark green cards. Full page width, `padding: 14px 2.6rem` like Billing.

### 2026-11-08 13:50 · Base · Growth: Marketing + Customer health on one page (clean redesign, mock)
- New `pages/growth/GrowthPage.tsx` / `.css` (prefix `.gr-`), route **`/growth`**. One tab bar: Overview · Attract (Campaigns, Ads, Website) · Keep (Customers, Follow-ups); `?s=` picks the section. Light, minimal design: white blocks, one action per block, details in a right side panel. All sample data ("Preview" chip) — nothing sent, paid or published.
  - Overview: 4 KPIs, "Needs you" list, where leads come from, one AI idea. Campaigns: list → panel (reach, likes, reposts, comments, DMs, demo clicks, funnel, by channel, AI advice); "New campaign" = 4-step studio (what → where → budget → AI-generated posts → Launch). Ads: wallet + ad accounts. Website: describe → generate → publish. Customers: health counts + list → panel with AI summary of e-mails/WhatsApp, mood, next step. Follow-ups: sequences on/off + step editor; rule: a reply from anyone at the client stops it.
- `BaseApp.tsx`: `/growth` opens with Marketing **or** Customer health access; `/marketing` → `/growth`, `/success` and `/health` → `/growth?s=customers`. The old Base Marketing (`contacts/ContactExport` MarketingPage) and Customer health (`clients/ClientsPage` CustomerSuccessPage) are no longer routed in Base (files kept).
- `framework/Dock.tsx`: one "Growth" item (megaphone) instead of Marketing + Health; items take an optional `also` page key. `pageAccess.tsx` / `OrgSteps.tsx`: labels "Growth · Marketing" / "Growth · Customers".

### 2026-11-07 21:10 · Base · Marketing + Customer health in Base (synced with Enterprise), Marketing mock: Studio, Ads, Results, Website
- **Sync from Enterprise** (copies, Base import paths): `pages/contacts/ContactExport.tsx` / `.css` (MarketingPage: overview, e-mail, social, calendar, audiences — as Enterprise today), `pages/clients/ClientsPage.tsx` (the CUSTOMER SUCCESS section to the end replaced with Enterprise's; Base's own part above kept: HeadFilter, Orbit), `ClientsPage.css`, `useClientsData.ts` (cs-engine, campaigns, flows), `CsFlow.tsx` / `.css` (new), `framework/LinkPopover.tsx` / `.css` (new). Needs the same SQL as Enterprise (17, 64, 108, 114) — shared DB.
- `BaseApp.tsx`: routes `/marketing` (page "marketing") and `/success` (page "success"; `/health` → `/success`). `framework/Dock.tsx`: Marketing (megaphone) and Health (heart) items. `framework/pageAccess.tsx`: "Customer health" label/hint; Marketing hint. `pages/settings/OrgSteps.tsx`: both pages offered per department / person. Customer success page titled "Customer health" in Base.
- `pages/marketing/MarketingLab.tsx` + `.css` (new, prefix `.ml-`, **mock — sample data, nothing sent/paid/published**): extra Marketing tabs **Studio** (one sentence → campaign on every channel: copy, visuals, calendar, budget split, expected reach/leads/CPL, "Launch everything"; agents: community manager, designer, copywriter, ads optimiser), **Ads** (wallet paid from Next, ad accounts Meta/Instagram/Google/LinkedIn/TikTok, running ads with pause), **Results** (reach, likes, reposts, comments, DMs, demo clicks; funnel post → client; per campaign; AI advice with Apply), **Website** (generate the site from Products & Services, style, pages, publish). `AccountSwitch` (brands / client accounts) in the header; `LeadStrip` (where leads come from) on Overview and Results.
- **IDEA→ENT**: Studio / Ads / Results / Website and the account switch could go to Enterprise Marketing too once they are real.
- Deploy: files written to the Mac and committed.

### 2026-11-07 09:40 · Enterprise · GDPR: only e-mail from people in the CRM is read, stored or shown
- Files: sql/116_mail_known_only.sql, sql/117_purge_unknown_mail.sql, supabase/functions/outlook-sync/index.ts, src/components/api/outlookSync.ts, src/components/pages/homepage/shared/HomeTodo.tsx, HomeShared.css
- What: one check in the database, `mail_is_known(tenant, email)`: known = a contact, a colleague (profiles), a company's e-mail, a client's own contact list, or the domain of a company (website / e-mail) or of a contact linked to a company (public domains like gmail.com only by exact address; linkedin.com & co. from a website field never count). Enforced in three places: (1) a BEFORE INSERT trigger on `ticket_mail_messages` drops any message whose sender (in) / recipients (out) aren't known — whatever code stores it; same for `tracking_tasks` with source 'email'; (2) a restrictive RLS policy hides stored mail whose people are no longer in the CRM (a contact / company removed) — client Emails tab, contact profile, desk Inbox, home, exports all read through it; (3) outlook-sync's `handleIncoming` asks `mail_is_known` first and skips the message entirely (no rules, no ticket, no rule hits), counted as `unknown` → the desk's sync note says "N left out: not in the CRM". Desk › Mail settings › Mailboxes shows a GDPR note. CS scans (cs-engine) already only log mail matched to a client's contacts. Konsolidator: 208 of 272 stored messages stay visible; 64 (newsletters / SaaS notifications) hidden — 117 deletes them.
- Tags: **DB**, PORT? (src/base/pages/homepage/shared/HomeTodo.tsx has the same Mailboxes tab text; the DB part already covers Base)
- Deploy: 116 applied. 117 to run in the SQL editor. outlook-sync source changed in the repo but **not redeployed** (the database already enforces it; deploy with `supabase functions deploy outlook-sync` to get the cleaner skip and the counter — note this also ships the committed CS changes since v23).

### 2026-11-07 09:10 · Enterprise · CS editor: step explanations in the left step list
- Files: src/components/pages/clients/ClientsPage.tsx, ClientsPage.css
- What: the explanation of each step no longer sits above the centre panel; the open step in the left list expands to show it (cs5-st-more) with an "Explain this step" button. Hover on any step shows the same text.
- Tags: PORT? no (Enterprise CS editor only)
- Deploy: none (frontend only)

### 2026-11-06 15:40 · Enterprise · CS editor: saved as you go; closing always asks
- Files: src/components/pages/clients/ClientsPage.tsx, ClientsPage.css (v5.3)
- What: every change in the campaign/sequence editor is saved ~1 s later (`persist` → `saveCsSequence`, a new one gets its id on the first save; `onAutoSaved` keeps the list in step without a flash). A draft (unsent campaign / sequence that's off) saves anything; something live (sent campaign / sequence that's on) only saves complete changes — otherwise the header says why it's held. Header badge: Saving… / Saved hh:mm / Not saved: why. ×, Esc, backdrop and the menu's Close open "Close the campaign/sequence?" (Keep editing / Close; Esc again = keep editing); Close waits for the last save.
- Tags: none
- Deploy: frontend only.

### 2026-11-06 15:25 · Enterprise · No native dropdowns left; CS day-by-day: small case pills, no day strip
- Files: src/components/pages/contacts/LinkedInCapture.tsx + ContactsPage.css, superadmin/SuperAdminCreate.tsx, SuperAdminHome.tsx, SuperAdmin.css, settings/ProposalTemplateEditor.tsx/.css, clients/ClientsPage.tsx/.css, clients/CsFlow.tsx/.css
- What: every `<select>` / `<datalist>` in src/components now uses `framework/Select` (LinkedIn capture: country, company, sector; superadmin: company filter, role; proposal editor: "Show only when" field; CS blueprint attachments: PDF form fields + font; team mailbox: known mailboxes as chips under the input). Rule: never the browser's own dropdown (the only `<select>` left is inside the HTML snippet ApiForms generates for clients' websites). CS "See it day by day": the cases are small pills ("Replies", "No open → Opens"…), the day strip is gone.
- Tags: PORT? (Base has its own copies of some of these pages)
- Deploy: frontend only.

### 2026-11-06 15:05 · Enterprise · CS editor: Back/Next under the steps, no summary line; replies count per client
- Files: src/components/pages/clients/ClientsPage.tsx, ClientsPage.css (v5.2), CsFlow.tsx
- What: the header loses its summary line (name only). Next / Send now / Save and Back sit at the foot of the left step list (icons only under 1100px). Checks say it plainly: the whole client counts — one reply from anyone at it is a reply ("Someone replies" / "Opened, no reply" / "Nobody opens it"). The engine already decided per client (all e-mails of that step for the client; `cs_mark_replies` by client) — no engine change.
- Tags: none
- Deploy: frontend only.

### 2026-11-06 14:45 · Enterprise · Calendar: who decides what an invitee bills + what the Outlook invite shows
- Files: src/components/pages/calendar/invitesApi.ts, InvitesTray.tsx, BookingModal.tsx/.css, CalendarPage.tsx, InviteBillAsk.tsx/.css (new), src/components/pages/homepage/HomePage.tsx, src/components/api/outlookSync.ts, sql/115_invite_bill_mode.sql
- What: summoning a colleague on client work: "I set it" (fixed figure) or "They decide" (figure = suggestion). Accepting an invite to billable work (calendar tray or Home notifications) opens `InviteBillAsk`: shows the fixed figure, or asks theirs (stepper, the service's min unit); `answerInvite(..., bill)` writes it on their entries and invites (one answer covers a series; later series dates keep it via `alert_invite`). Pending invites follow the organiser's later changes of figure/mode. Booking review step: "In the Outlook invite" chips (type of work, client, project, phase, tasks, role, billable time, client people, team, notes) → `calendar_entries.outlook_hide`; default hides billable; your last choice is remembered (`profiles.prefs.outlook_hide`); `syncCalendarEntry` leaves those out of the event body.
- Tags: DB · PORT? (Base calendar/invites have their own copies)
- Deploy: SQL 115 applied (bill_mode, alert_invite, outlook_hide). Frontend.

### 2026-11-06 14:20 · Enterprise · CS flow: dates without weekday names
- Files: src/components/pages/clients/CsFlow.tsx
- What: dates read "4 Jan" (no weekday) in the cards and the day-by-day view; the day strip shows the month only on its first day and on the 1st.
- Tags: none
- Deploy: frontend only.

### 2026-11-06 14:00 · Enterprise · CS editor: no footer, actions in the header, steps on the left
- Files: src/components/pages/clients/ClientsPage.tsx, ClientsPage.css (v5.1 block), CsFlow.css
- What: footer removed. Header: One-time / Recurring and "How it works" as icon buttons whose label opens on hover; "⋯" menu (Save as draft / Save, keep it off / Save and switch on / Cancel, with the status note); Back and Next as icon buttons (Next's label on hover); last step: "Send now to N people" / "Save". The steps run down a left column (196–224px; numbers only under 1100px) with the status note under them. Scrollbars hidden (still scroll) in the side list, steps, hover card, day strip and form. Path names wrap instead of being cut.
- Tags: none
- Deploy: frontend only.

### 2026-11-06 13:40 · Enterprise · CS flow: example calendar from 1 January + clearer cards
- Files: src/components/pages/clients/CsFlow.tsx, CsFlow.css, ClientsPage.tsx, ClientsPage.css
- What: Steps step has "Build the steps" / "See it day by day". The day-by-day view (`CsFlowCalendar`, `flowStories`) plays one client through the flow from an example day 0 = 1 January (a sent campaign: its real send day): one case per way the checks go (replies / opens, no reply / doesn't open), a strip of days (waits shaded) and a dated agenda (e-mails, waits, outcomes, tasks with due day, end). Builder cards show the date first ("Mon 4 Jan · Day 3"), the wait in words inside the card ("Sent [3] days after the step before / the check decides / they reply"), checks say the day they decide, paths "Any day until…" / "On…".
- Tags: none
- Deploy: frontend only.

### 2026-11-06 13:10 · Enterprise · CS flow: every step says its day (and date for campaigns)
- Files: src/components/pages/clients/CsFlow.tsx, CsFlow.css, ClientsPage.tsx
- What: `flowDays(nodes)` works out when each step happens from day 0 (a range when it depends on a reply: replied path = any time up to the check's end). Each card shows "Day N" (campaigns also the date: sent date, or today if sent now); checks say the day they decide; paths say "From day N" / "Any time up to day N"; tasks show their due day; the Steps tab sums "over/up to N days".
- Tags: none
- Deploy: frontend only.

### 2026-11-06 12:40 · Enterprise · CS campaign/sequence editor v5: steps, timeline, field cards, on/off list
- Files: src/components/pages/clients/ClientsPage.tsx, ClientsPage.css (`.cs5*` block at the end), CsFlow.tsx, CsFlow.css, useClientsData.ts, supabase/functions/cs-engine/index.ts
- What: the editor is one step at a time (Audience · Timing (recurring) · Steps · Delivery) with Back/Next; slim header; the flow is a timeline (tiles on a rail, wait pills, "+" between steps, add-step menu); task title/notes use `ChipField` (fields as cards, stored as {{key}}); `FIELD_CHIP`/`FIELD_GROUPS` now live in CsFlow.tsx. Right list narrower (300–340px): people count per client with a hover card of its addresses, Clients/E-mails switch, search, on/off switches. New `audience.exclude_emails` (lower case): csTo leaves them out; cs-engine v3 never sends to them.
- Tags: PORT? (Base has no CS sequences — skip unless it gets them)
- Deploy: edge function cs-engine v3 (verify_jwt false). No SQL.

### 2026-11-06 21:15 · Enterprise · CS: company contacts count as client contacts
- Files: src/components/pages/clients/ClientsPage.tsx, supabase/functions/cs-engine/index.ts
- What: Customer success used only `clients.contacts` (jsonb) for recipients, so clients whose people live in Companies › Contacts showed "No e-mail on file". Now each client's own list + its company's contacts (company_contacts → contacts with e-mail), deduped by e-mail, in the CS page and in the engine (recipients, {{first_name}}).
- Tags: PORT? (Base CS page, if it lists recipients)
- Deploy: edge function cs-engine v2 (verify_jwt false). No SQL.

### 2026-11-06 10:10 · Base · Products & Services: unit beside the price
- `pages/settings/BaseCatalog.css`, `NewWalkthrough.css`: "/ year", "/ month"… sit to the right of the price, not below.

### 2026-11-06 10:05 · Base · Products can be paid weekly
- `pages/settings/catalogApi.ts`: `billing_period` may be `"weekly"` (no DB constraint on it).
- `pages/settings/BaseCatalog.tsx` / `.css`: billing switch Weekly · Monthly · Yearly · One time; "/ week" unit and "Weekly" tag.
- `pages/settings/NewWalkthrough.tsx` / `.css`: "How is it paid?" adds Every week (2 × 2 options).
- `pages/sales/sales/salesApi.ts`: `lineBreakdown` counts a weekly line × 52 a year ("x 52 weeks x N years").
- **IDEA→ENT**: Enterprise reads `products.billing_period`; a weekly product there would be counted as yearly unless it learns "weekly" too.
- Deploy: files written to the Mac and committed.

### 2026-11-06 10:40 · Enterprise · Customer success: sequences with branches (opened / replied), tasks, e-mail tracking, cs-engine function, Send now asked twice
- **Files:** `src/components/pages/clients/CsFlow.tsx` + `.css` (new), `ClientsPage.tsx/.css`, `useClientsData.ts`, `supabase/functions/cs-engine/index.ts` (new, deployed v1), `sql/114_cs_flows.sql` (written, not applied).
- **What:** the CS sequence/campaign editor's steps are a tree: E-mail, "Wait & check" (wait N days, then lanes Replied · Opened, no reply · Didn't open; a reply is taken as soon as it's seen), Task (for the client's owners / main owner / sender / a person, due in N days), End; a lane carries on with the steps after the check. One-time campaigns can have follow-ups too. Per e-mail step: sent / opened / clicked / replied; clients waiting at each step. Every e-mail is tracked (1×1 pixel + links through cs-engine `?t=o|c`), replies = a client e-mail read from people's mailboxes or the team mailbox (CS Iberia) after ours (`cs_mark_replies`). "Send now" opens a 2-step confirm and the server requires `confirm: <id>`. All CS e-mail now goes through the new **cs-engine** function (moved from outlook-sync, which keeps its old copy unused); old straight sequences keep working (read as a tree).
- **Tags:** PORT? Base has its own CS page (no sequences engine).
- **Deploy:** SQL 114 applied 2026-11-06 (hourly job → cs-engine). M365: the sender needs "Full Access" on the team mailbox to read its replies.

### 2026-11-06 07:45 · Enterprise · Website forms you build (Settings › APIs), account manager star, 2 phones from Companies, full filter chips
- **Files:** `src/components/pages/settings/ApiForms.tsx` (new), `ApiSettings.tsx/.css`, `src/components/pages/companies/CompaniesPage.tsx/.css`, `companiesApi.ts`, `supabase/functions/manage-users/index.ts` (v19 deployed), `sql/113_account_manager.sql` (written, not applied yet).
- **What:** Settings › APIs › **Website forms**: each workspace builds its forms — question, name it's sent as, where it lands (contact/company column, own field, a new field made there, or notes), required — and gets the code with the key inside (ready-made HTML form, JS for an existing form, a note for the web developer); form keys keep `settings.public_key` (they only add leads) so the code can be copied any time; `settings.fields` drives `/crm/leads` (missing required → 400 `{ missing }`). Import keys (full) separate, shown once. Companies: Visibility chips get a ☆ — the starred person is the **account manager** (`is_manager`); list column + filter + sort "Account manager"; the old custom field is migrated by SQL 113. New contact from a company: Telephone + Mobile like Contacts. Filter chips show every value and wrap (no "+2", no 380px cut); in the filter panel picked values come first.
- **Tags:** PORT? Base FilterChips/fxSummary + NewContactInline (same "+2" / one phone); Base has no APIs page.
- **Deploy:** SQL 113 applied 2026-11-06 (12,559 companies got their starred account manager). Edge function done.

### 2026-11-06 07:40 · Base · Products & Services: pro rows + walkthrough for new ones
- `pages/settings/BaseCatalog.css`: rows restyled — gradient hairline border in the item's colour, soft glow, glossy tile, sheen on hover, round chevron that fills on hover; a mini picture per row (`.bc-row-viz`): a product's tiers as a price ladder, a service's steps as a track (sized by % when billed by step).
- `pages/settings/NewWalkthrough.tsx` + `.css` (new, prefix `.wk-`): "+ Product" / "+ Service" / New menu / empty page open a walkthrough. Product: name & kind → how it's paid (monthly / yearly / one time) → price (one price or tiers) → preview & create (`saveProduct`). Service: name → steps → how it's billed → price (+ % per step, split evenly) → preview & create (`saveBaseService`). "Skip the walkthrough" / × / Esc hands what's filled in to the usual editor (new product card / service pop-up).
- `pages/settings/BaseCatalog.tsx`, `BaseServices.tsx`: wiring + row pictures.
- Deploy: files written to the Mac; user to commit.

### 2026-11-06 07:00 · Base · Products & Services: two columns, list rows that open
- `pages/settings/BaseCatalog.tsx` / `.css`: Products on the left, Services on the right, each with its own "+ Product" / "+ Service". Every item is a row of the same height (tile, name, kind / billing / tiers or steps tags, price or price range + unit); click a product to open it into the editing card (collapses back with the arrow; stays open while unsaved; new ones open).
- `pages/settings/BaseServices.tsx`: `ServiceCard` is a row that opens to show its steps and an "Edit service" button (the pop-up as before).
- Deploy: files written to the Mac; user to commit.

### 2026-11-06 06:40 · Base · Organization chart: departments in their colours
- `pages/settings/OrgSteps.css`: each department in the chart takes its own colour (edge, tint and count); a default colour on `.oc-dept` was overriding it.
- Deploy: file written to the Mac; user to commit.

### 2026-11-06 06:30 · Base · Organization chart left to right
- `pages/settings/OrgSteps.tsx` / `.css`: the chart on the right reads left to right (`.ht-node` / `.ht-kids` connectors): Company → its departments, each with how many people (no avatars); a department → who reports to whom. Centred in its box, still shrinks to fit.
- Deploy: files written to the Mac; user to commit.

### 2026-11-06 06:15 · Base · Organization: managers lead their department; only the lists scroll; simpler New user
- `pages/settings/OrgSteps.tsx` / `.css`: a department's two levels are always listed even when they are built-in ones (e.g. "Consultancy manager" was hidden). Picking "<Dept> manager" for someone makes everyone else in the department report to them (`profiles.manager_id`); someone moved into a department reports to its manager. Levels: the department's two + Boss on top, the rest behind a toggle that opens and closes ("Show fewer"). Only the department and people lists scroll (header, add rows and pages card stay); room at the bottom of every panel (`.st-org-steps` no page padding).
- `pages/settings/NewUserModal.tsx`: no Birthday and no Social security number; "Bank account (IBAN)" label (payload keeps the keys, empty).
- Deploy: files written to the Mac; user to commit.

### 2026-11-06 05:55 · Base · Organization fits the page; back + superadmin crown in the Departments panel
- `pages/settings/OrgSteps.tsx` / `.css`: no sideways scroll — the columns share the width and the chart scales itself down to fit its box. The page has no header any more: the back arrow and the superadmin crown sit in the Departments panel's header (`onBack`, `corner` props). Fix: the levels made for a department now take its name (they were named after its key, e.g. "consultancy"); Brazo's 7 such levels renamed in the DB, and its 6 consultants moved from the built-in "Consultant" to "Consultancy".
- `framework/SuperAdmin.tsx`: `SuperAdminSwitch({ compact })` — a small crown button (`.st-sa-crown`), nothing for non-superadmins.
- `pages/settings/SettingsPage.tsx`: Organization = just `<OrgSteps onBack corner={<SuperAdminSwitch compact />} />`.
- Deploy: files written to the Mac; user to commit.

### 2026-11-06 05:10 · Enterprise · Settings › APIs: website demo form → companies & contacts (CRM import API)
- **Files:** `src/components/pages/settings/ApiSettings.tsx` + `.css` (new), `src/components/pages/settings/SettingsPage.tsx`, `supabase/functions/manage-users/index.ts` (v17 deployed), `sql/111_crm_import_api.sql`, `sql/112_company_fields_light_refresh.sql` (both applied).
- **What:** new Settings › Your company › **APIs** (bosses, managers, CRM leads): lead keys (`scope crm`: "Website form" = only `POST /crm/leads`, or "Full import" = also `/crm/companies`, `/crm/contacts`; source, type tags, people to assign, allowed websites), the demo form's field map with "Create the fields", how to connect it (URL, JSON, fetch, curl) and the endpoints; the client documents keys + endpoints moved here from Settings › Clients (it now has an "API access" pointer). Edge function: `/api/crm/leads` finds the company by name or e-mail domain (not free mail) and the contact by e-mail, creates or fills in, links them, merges multi-choice fields, adds new choices to the field, notes the request in the contact; shortcuts `employees`/`entities`/`erps` (company) and `interests` (contact); honeypot `_hp`. Konsolidator: fields Employees, Legal entities, ERPs (company) and Interested in (contact) created. SQL 110 was taken by Base → this is 111/112.
- **Tags:** PORT? Base Settings has no APIs page (Base could reuse ApiSettings.tsx as is — it only needs the manage-users API).
- **Deploy:** done (SQL applied, manage-users v17). Nothing to run.

### 2026-11-06 05:30 · Base · Organization: auto levels per department, person details, light chart
- `pages/settings/OrgSteps.tsx` / `.css`: department colour is automatic (no picker); each step card sits on top of its panel; scrollbars hidden (still scroll). People panel: "New person" / "Move in" as dashed rows at the end of the list; "Pages it opens" as chips; "Its levels".
- **Security levels made for you**: Boss always; for every department "<Dept>" and "<Dept> manager" (rows in `security_levels`, dept_key = the department; base role = the department's built-in roles when it has them, else consultant / consultancy_manager). Created on load for any department missing them (managers only); renaming a department renames its two levels. Built-in roles are only listed when someone is on them. Moving someone to a department puts them on its level (or its manager level if they were a manager); a new person made from a department gets its level.
- Person panel: first / last name, yearly wage (`profiles.salary`), phone, IBAN they're paid to (`profiles.bank_iban`), saved on blur.
- Right side: a light chart — the company (departments with their people) or the department picked (who reports to whom, from `manager_id`); clicking it picks the department / person.
- Deploy: files written to the Mac; user to commit.

### 2026-11-06 04:40 · Base · Organization in steps (no map)
- `pages/settings/OrgSteps.tsx` + `OrgSteps.css` (new, prefix `.os-`): Settings › Organization is now three panels that open side by side — **1 Departments** (create / pick; a new company starts with none, 100% custom), **2 the department** (rename inline, colour, its people, New person (NewUserModal → manage-users, put in the open department), "Move someone in", pages the department opens, remove), **3 the person** (security level as cards — the department's first, "Show every level" —, department, reports to, pages: via department / level, or opened just for them by name, delete account). Same tables as before: org_departments, profiles (department / security_level / role / manager_id), security_levels, page_departments (dept_keys + user_ids). Pages offered are Base's: Tasks, Calendar, Orbit (contacts), Deals (sales), Billing (management).
- `pages/settings/SettingsPage.tsx`: Organization renders `OrgSteps` (no map, no time bar, no Page access button); `Organization.tsx` (the map) is no longer used by Base — left in place.
- Deploy: files written to the Mac; user to commit.

### 2026-11-05 18:20 · Base · Tasks = board only; Orbit header filters, fewer type chips, "client for what"; Billing tab names
- `pages/homepage/shared/HomeTodo.tsx` (+ `HomeShared.css`): Tasks page is the board only (no list/board switch), no "All" tab, no Type (filter, column, chip, field), no Team field, no Watchers (compose + task) — @mentions still notify. List table without the type column (`.tk-table.is-notype`).
- `pages/settings/SettingsPage.tsx`: no "Tasks" tile (predefined tasks/processes) and no "Tasks page" security tile.
- `pages/companies/CompaniesPage.tsx` (+ css): `HeadFilter` (exported) — a funnel on each column header opens that column's filter in place (same FCond model as the Filters builder); used on Companies, Contacts (`ContactsPage.tsx`) and Clients list (`ClientsPage.tsx`). `TypeChips`: no "CRM" chip, 2 at most. Company panel: turning on **Client** asks "A client for what?" (products/services from the catalogue) → saved in `companies.custom.__client_for` (["product:Name", "service:Name"]), shown as "Client for …".
- `pages/billing/BillingPage.tsx` / `InvoiceModal.tsx`: tabs Invoiced · To invoice · Time; in To invoice the sections are "Proposed invoices" (automatic / manual) and "To bill".
- Deploy: files written to the Mac; user to commit.

### 2026-11-05 13:30 · Base · Billing: Invoices / To invoice, automatic vs manual, XML export (Facturae), new invoice window; Orbit Clients switch
- **DB** `sql/110_base_invoice_source_seller.sql` (applied; 105 was taken by Enterprise): `invoices.source` ('manual' | 'auto', default manual, Enterprise never reads it); `base_billing_settings.seller_*` (name, tax_id, street, postal_code, city, province, country, iban, email) — the issuer on invoices and in the XML; `base_bill_up_to` now inserts `source = 'auto'`. Brazo's 2 renewal drafts marked auto; Brazo issuer filled with demo data.
- `pages/billing/BillingPage.tsx`: tabs **Invoices · To invoice · Time** (`?view=tobill` still works). Invoices = issued only (sent/paid/void), 4th KPI "Invoiced this month" instead of Drafts, row checkboxes + **Export XML** (selected, else what's shown). **To invoice** = drafts (badge Automatic / Manual, filter chips) + "Not invoiced yet" (the old To bill cards/list).
- `pages/billing/ExportModal.tsx` (new): Facturae 3.2.2 export, one .xml per invoice / .zip (jszip) for several; drafts & void left out; "Your details" (issuer) edited and saved here.
- `pages/billing/billingApi.ts`: `Invoice.source`, `Draft.source`, `Seller` + `loadSeller/saveSeller/sellerMissing/sellerAddress`, `facturaeXml`, `exportFacturae`, `splitAddress`; print shows issuer VAT/address/IBAN.
- `pages/billing/InvoiceModal.tsx`: redesigned — the invoice as a sheet (From / Bill to / lines / totals / notes) + side panel (total, timeline made→sent→due→paid, actions: Send / Mark paid / PDF / XML / delete·void·restore). Source badge in the header. `seller` is now a `Seller`; new `onExport`.
- `pages/billing/Billing.css`: page bits (.bz-xml, .bz-check, .bz-selbar, .bz-src, .bz-drow, .bz-sec, .bz-hero-split) and the whole modal section rewritten (.bzi-paper, .bzi-side, .bzi-steps, .bze-* export).
- `pages/orbit/OrbitLook.css`: switching to/from Clients — the client grid now slides in / fades out like the other views (it showed the companies list through it and replayed its cards' entrance).
- **IDEA→ENT**: Facturae export and invoice source could serve Enterprise invoices too.
- Deploy: files in outputs/v25 → Mac; user to commit.

### 2026-11-05 16:25 · Enterprise · Client files API: downloads of files with "∙", "–", accents… no longer answer 500
- files: `supabase/functions/manage-users/index.ts`
- `GET /api/clients/:id/files/:fileId/content` put the raw file name in `Content-Disposition`; a header can only carry Latin-1, so names like "Informe ∙ Q3 – 2026.pdf" threw and the API answered 500. Now `disposition(name)`: `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded real name>` (RFC 6266/5987) — clients that read `filename*` get the exact name.
- deploy: edge function `manage-users` deployed (v16, verify_jwt off, as before); file written to the Mac (cs65)

### 2026-11-05 13:30 · Enterprise · Marketing opens at once · {{fields}} as chips
- files: `pages/contacts/ContactExport.tsx` (+ `.css`)
- Speed: the page no longer waits for the whole CRM (every contact, company, deal, plus last-contact dates) before showing anything. Campaigns, templates, social and calendar show as soon as the marketing tables are read (~0.3 s); only Audiences and the composer wait for the CRM. The CRM is kept 5 min in memory (`marketingWorld()`), so coming back is instant; last-contact dates (`loadLastTouch`) load after it (`marketingTouch`) and the engine picks them up.
- Fields: in the composer's text and subject (now a one-line contentEditable) `{{first_name}}` etc. show as chips (`mk-fld`, like CS blueprints); the e-mail keeps `{{…}}` (`mkToChips` / `mkFromChips`); Insert puts a chip at the caret. Campaign list, template cards and AI subject options show chips too (`ChipText`).
- deploy: written to the Mac (cs64)

### 2026-11-05 13:10 · Enterprise · Marketing e-mail templates (SQL 109, applied) · links in e-mail editors
- files: `sql/109_mk_templates.sql` (new), `framework/LinkPopover.tsx` + `.css` (new), `pages/contacts/ContactExport.tsx` (+ `.css`), `pages/clients/ClientsPage.tsx`
- DB: `mk_templates` (name, subject, preheader, body_html, used_count; tenant RLS + `trg_set_tenant`).
- Marketing › E-mail: **Campaigns | Templates** switch. Templates: cards (subject, preview line, text), Preview (the real e-mail in a frame), Use (a new campaign starts from it), rename, delete. In the composer (Message step): "Start from a template…" and **Save as template** (new, or replace an existing one).
- Links (Marketing composer + CS blueprint editor): the Link button opens `LinkPopover` — with text selected, the link goes on it; with nothing selected you choose "In a text I write" or "The address itself". `acme.com` → https://, `ana@acme.com` → mailto:.
- **PORT?** Base copies of ContactExport (if any) / CS blueprint editor: `LinkPopover` is a new framework component (not kernel), Base may copy it.
- deploy: written to the Mac (cs63); migration applied

### 2026-11-05 12:40 · Enterprise · Customer success: one-time e-mail campaigns + sending from a team mailbox (SQL 108, applied)
- files: `sql/108_cs_campaigns.sql` (new), `pages/clients/ClientsPage.tsx` (+ `.css`), `pages/clients/useClientsData.ts`, `supabase/functions/outlook-sync/index.ts`
- DB: `cs_sequences` + `kind` ('sequence' | 'campaign'), `from_address`, `launched_at`, `launched_by`.
- Automatic e-mails › "Campaigns & sequences": **New campaign** (one blueprint, sent once with **Send now**) next to New sequence; the editor switches One-time / Recurring. Campaign cards: Draft → Sending… → Sent <date>, sent / failed counts, copy to send again.
- **From a team mailbox** (both kinds): any address (suggestions from `ticket_mailboxes`), sent with the sender's own Outlook token (`Mail.Send.Shared`, already granted) via `/users/{box}/sendMail`, falling back to `/me/sendMail` with `from` (Send as). "Send me a test" checks the permission. Shared mailboxes have no password: the M365 admin gives "Send as" (+ "Read and manage" for Sent Items).
- Edge function: `csSend(…, from)`, `csRun(tenant, budget, seqOnly, deadline)` (campaigns never take clients in by themselves), new action `cs_campaign` (enrols who matches now — upsert, keeps rows set by hand — then sends up to ~110 s; the rest go on the hourly run), `cs_test` takes `from`.
- **deploy: the edge function is written to the Mac but NOT deployed yet** — `npx supabase functions deploy outlook-sync --project-ref eloadnqjcrvdnvdcoqap`. Until then: campaigns can be created and saved, Send now answers an error.
- **PORT?** Base copies of ClientsPage / useClientsData if Base has CS e-mails.

### 2026-11-05 12:00 · Enterprise · Companies / Contacts: Settings › Security now decides who sees what (SQL 107, applied)
- files: `sql/107_crm_scope_from_settings.sql` (new), `framework/pageAccess.tsx`, `pages/companies/CompaniesPage.tsx`, `pages/contacts/ContactsPage.tsx`
- DB: `crm_scope_ids(page)` reads `page_data_scopes` for the signed-in person (person › security role › department › default; boss / Boss-based levels / superadmin = all) → null (everything) or the people whose records they see (them, or their department). `companies_list` (assignees ∩ those people, or created_by), `contacts_list` (assignees), `global_search` (each kind by its own page) use it instead of the hard-coded lead roles (replaces SQL 106's list). Nothing saved for the page → sales_manager / marketing_manager all, the rest "mine".
- The saved Companies / Contacts defaults of "all" had never been applied → set to "mine" + roles sales_manager / marketing_manager "all" (marketing's own "all" kept). Checked: Santiago 15,157 / 21,652, Antonio 0 / 1 (as before), boss everything.
- UI: `PAGE_SCOPES.companies/contacts` get `fallback` (shown when nothing is saved) and clearer labels; the in-browser list (no server mode) filters with `useDataScope`.
- **DB** · **PORT?** Base's own `src/base/framework/pageAccess.tsx` (fallback + labels) — the database rule already applies to Base tenants.
- deploy: written to the Mac (cs61); migration applied

### 2026-11-05 11:40 · Enterprise · Marketing manager sees every company and contact (SQL 106, applied)
- files: `sql/106_marketing_manager_sees_crm.sql` (new), `pages/companies/companiesApi.ts` (+ `isCrmLead`), `pages/companies/CompaniesPage.tsx`, `pages/contacts/ContactsPage.tsx`
- DB: the "lead" test in `companies_list`, `contacts_list`, `global_search` and `crm_is_lead` (105) now includes `marketing_manager` (boss, sales_manager, marketing_manager, superadmin see everything; the rest only what's assigned to them / what they add). Checked as Santiago: 15,157 / 15,157 companies, 21,652 / 21,652 contacts.
- UI: Companies / Contacts filter by assignees with `isCrmLead` (visibility only); assign / delete / merge stay boss + sales manager (`isSalesLead`).
- **DB** · **PORT?** Base's `src/base/pages/companies/companiesApi.ts` + Companies/Contacts pages if Base keeps per-user visibility.
- deploy: written to the Mac (cs60); migration applied

### 2026-11-05 10:20 · Enterprise · Whoever adds a company / contact can see it (SQL 105, applied)
- files: `sql/105_creator_sees_own_records.sql` (new)
- Cause: non-leads (anyone not boss / sales_manager / superadmin) only see companies and contacts in their `company_facts.assignees` / `contact_facts.assignees` (`companies_list`, `contacts_list`, `global_search`), and nobody assigned the creator — Santiago (marketing) added "Tilseco Energy Group" and its contact Mikel Garcia Rocha and couldn't see them.
- Fix: `crm_is_lead(uuid)`; statement triggers `crm105_co_creator` / `crm105_ct_creator` (after insert on companies / contacts) add `auth.uid()` to company_assignees / contact_assignees when the creator isn't a lead; backfill from `crm_history` (created/imported by non-leads: Tilseco, Mikel Garcia Rocha, Raul Puche, "Facturacion").
- **DB** — Base: your simple CRM inserts into the same tables, so the triggers apply there too (harmless: Base users get assigned to what they create).
- deploy: file written to the Mac; migration applied 2026-11-05 10:15

### 2026-11-05 09:40 · Base · Simple deals: no proposals, no close probability, one price per line
- files: `pages/sales/trackings/TrackingDetail.tsx` (`SIMPLE`), `pages/sales/trackings/SimplePriceModal.{tsx,css}` (new), `pages/sales/sales/SalesPage.tsx`, `pages/sales/sales/SalesForecast.tsx` (`BASE_FULL`), `pages/settings/SettingsPage.tsx`.
- Deal page: no Proposals card (dropped from saved layouts too) and no proposal documents under lines; "Close probability" card → **Close date** (expected close + actual close, no sliders, no management estimate); no "% close" chips in the hero; "Calculator" card → **Price**.
- Lines: no versions, no preconfigured calculators. "Edit price" opens `SimplePriceModal`: tier (if any), price, quantity / years, **extras** that add to the price, discount (% or €). Saved on the line as before: `price` = base + extras, `calc_values` = `{ base, "add:<label>": amount }`, `discount_mode/value` — so every total keeps working.
- List: no "Close chance" column, no "Weighted value" column/export field. Forecast: full values only (no Weighted toggle, no % rings or bands); KPIs: Open pipeline · Next 90 days · Overdue.
- Settings: no "Proposal template" card.
- Not touched (Enterprise fields kept in the DB): `rep_close_prob` / `mgr_close_prob`, phase `close_probability` (still editable in Settings › Pipelines).

### 2026-11-05 09:10 · Base · No ticketing in Base: tasks only, + link your e-mail to send invoices
- files: `pages/homepage/shared/HomeTodo.tsx`, `pages/homepage/HomePage.tsx`, `pages/clients/ClientWorkspace.tsx`, `pages/settings/SettingsPage.tsx`, `BaseApp.tsx`, `framework/Dock.tsx`, `framework/pageAccess.tsx`.
- The desk (`TicketDesk`, Base copy) is tasks only (`TASKS_ONLY`): no Tickets/Tasks switch, no ticket Inbox, no mail sync, no desk settings (mail rules, mailboxes, SLAs), no SLA badges. Tasks keep everything else: assignees, @mentions, steps/processes, priorities, due dates, board/list, saved views, internal notifications.
- Route `/tasks` (page access key stays `tickets`, label "Tasks"); `/tickets?…` redirects to `/tasks?…`; dock order "/tickets" → "/tasks".
- Home: desk card "Your tasks", "Open tickets" figure never offered, search: no tickets / "Log a ticket", notifications: no "Tickets" tab.
- Client workspace: no Tickets tab and no Emails tab (`NO_TICKETING`); Settings › Client page: no "Mail rules"; Settings › Tasks page security card renamed.
- Settings › Interface (next to Outlook): **"Your e-mail, to send invoices" → Link e-mail** = `connectOutlook({ withMail: true })` (Mail.Read/Send). Next step (later): invoice templates + sending from that mailbox.
- **IDEA→ENT**: none (Enterprise keeps ticketing).

### 2026-11-05 08:50 · Base · Billing: KPI cards, To bill as a list, Time with a scrolling client column
- files: `pages/billing/{BillingPage.tsx, Billing.css}`.
- Invoices: four separate KPI cards (icon, count, amount counting up, a 6-month sparkline, share of the total along the bottom; "Paid this month" shows the change vs last month). Click = filter, as before.
- To bill: Cards · List switch (remembered per browser, `bz.tobill`); the list is a table card — client, who, work, shipments, amount with a bar, Create invoice; a row opens its entries.
- Time: "By client" is as tall as "By person" (min 440 px) and scrolls on its own, header sticky.

### 2026-11-05 08:00 · Base · Redesign: Billing, Orbit and Deals share one look
- files: `pages/billing/{BillingPage.tsx, Billing.css, InvoiceModal.tsx, AutoInvoiceModal.tsx}`, `pages/orbit/OrbitLook.css` (new) + its import in `OrbitPage.tsx`, `pages/sales/sales/DealsLook.css` (new) + its import in `SalesPage.tsx`.
- Billing: class prefixes renamed `.bl-/.bi-/.ba-` → `.bz-/.bzi-/.bza-` (Enterprise's BacklogPanel.css / BillingPanel.css use the old ones and leaked in, which broke the header). The page scrolls as a whole with a sticky header; Invoices = one summary card (4 figures + a paid/unpaid/overdue/draft bar), filter chips, one table card grouped by month with client marks; To bill = hero with the total + automatic-invoices note, a grid of client cards; Time = month hero with KPIs, people with bars split by client (a colour per client), clients list.
- Orbit (only inside Orbit, `.ob-pane …`): the lists are one table card (header strip + hairline rows, no floating rows), softer marks in a few hues; clients grid roomier.
- Deals (`.sl.sl-ov …`): light paper; header + KPI cards in one dark rounded hero; list, board and forecast on the paper (board columns lighter).
- Checked in the sandbox harness at 1600 px (no live check: the built-in browser's session is signed out).

### 2026-11-05 07:25 · Base · Demo team for Brazo: 6 consultants with time on clients
- files: none (data only). **DB** (data).
- The user created lucia / marcos / sara / pablo / elena / javier @brazo.com; filled names, job titles, department consultancy, level consultant (Inder: first name).
- Each on the Team of 4 clients; client work Mon–Fri since 1 Sep (2–3 blocks a day, a few days off; Elena / Pablo / Lucía heaviest, Javier / Sara lightest). Sep + Oct billed (added to that client's month invoice, or a new one); Nov unbilled → To bill / automatic run on 1 Dec.
- All Brazo Base invoices renumbered in issue order (2026-0001…). Now 82: 48 paid, 23 unpaid, 8 overdue, 3 drafts.

### 2026-11-05 07:20 · Base · Automatic invoices on a cutoff date + a simpler Calendar
- files: `pages/billing/AutoInvoiceModal.tsx` (new), `pages/billing/{BillingPage.tsx, billingApi.ts, Billing.css}`, `pages/calendar/{CalendarPage.tsx, WorkModal.tsx, WorkModal.css}`, `sql/104_base_auto_invoices.sql` (new).
- Billing: "Automatic invoices" button in the header (shows the next run), the modal (cutoff day, drafts or sent, next cutoff + what it would bill, Bill now, recent runs), a note on To bill.
- Calendar: the role/target bar ("All billable", days, revenue, Enterprise billing cutoff) is gone; hours on clients per person + days to the Base cutoff. WorkModal's "Something else" = a plain titled entry (kind `internal`). Unused target code removed from CalendarPage (3 fewer tsc errors).
- **DB** 104 applied (07:10), cron job `base-auto-invoices` scheduled. Brazo: automatic invoices on, cutoff = last day of the month, as drafts (first run 1 Dec for Nov). Dry run (rolled back): 14 invoices, €33,562.52 net, numbers/lines/totals right.
- Demo workers: not created — the 6 people need sign-in accounts (Settings › Users › New user); their calendar entries get seeded once they exist.

### 2026-11-05 06:40 · Base · Billing page (invoices, to bill, time) + simple client work / shipments in the Calendar + client team
- files (new): `pages/billing/{BillingPage.tsx, InvoiceModal.tsx, billingApi.ts, Billing.css}`, `pages/calendar/{WorkModal.tsx, WorkModal.css}`, `pages/clients/{ClientTeam.tsx, ClientTeam.css}`, `sql/103_base_billing.sql`
- files (changed): `BaseApp.tsx` (route `/billing` under page `management`), `framework/Dock.tsx` (Billing item + icon), `pages/calendar/CalendarPage.tsx` (new entry → WorkModal; client_work/shipment entries open it; `isBilled`/`unitOf` know client_work = hours; billed entries not draggable; shipments blue), `pages/clients/ClientWorkspace.tsx` (Team card before "Last contacted").
- **DB** 103 applied in Supabase (only adds; widens `invoices_status_check` with `draft`). Enterprise invoices untouched: they keep project_id + period; Base ones have project_id null.
- Rates: an hour bills at the client's `price_per_day` ÷ 8, else the hourly / daily service (Brazo: Consulting 750/day → 93.75/h). Tax / terms from the client (`taxed`, `tax_rate`, `payment_days`). "Send" marks it sent and opens a mail to the billing e-mail (no mail server: attach the PDF from Print / PDF).
- Demo data (Brazo): client work Mon–Fri since 1 Sep for Inder on 14 clients, 6 ERP Connector shipments, 46 invoices (Sep/Oct work per client + yearly Consolidation renewals: paid, unpaid, overdue, 3 drafts), clients set to 21 % VAT and 30/45/60 days, Team = Inder on 12 clients.
- **IDEA→ENT**: Enterprise could reuse `invoice_lines` + client invoices for anything billed outside a project period.

### 2026-11-05 03:30 · Base · Demo deals + 3 sales pipelines for Brazo
- files: none (data only, applied in Supabase to tenant Brazo `076c824d…`). **DB** (data, no schema).
- Pipelines (`is_sales`): "Software · New business" (Lead 10 → Qualified 25 → Demo 40 → Proposal 60 → Negotiation 80 → Won/Lost), "Services" (Request 15 → Scoping 35 → Proposal 60 → Negotiation 80 → Won/Lost), "Expansion" (Opportunity 30 → Proposal 60 → Negotiation 80 → Won/Lost). Links: chain, last → Won, every stage → Lost.
- Deals (`trackings` + `tracking_products` / `tracking_potential_services`, owner inder, a contact, phase events):
  - Won: 40 licence deals on existing clients (Consolidation at their tier, + ERP Connector when signed, close_date = signing date) and 20 services deals (Implementation / Consulting); 2 Expansion wins.
  - Open: 30 software on non-clients spread over the stages, 8 services, 12 expansion on clients (Reporting Pro / Customer Success).
  - Lost: 8 software with loss reasons.

### 2026-11-05 03:10 · Enterprise · Reports: per-year figures "this period" / "next period" (ARR, licences, services, contract value)
- files: `pages/sales/extras/salesReportEngine.ts`, `pages/sales/extras/SalesReport.tsx`
- New columns, read from the contract's year-by-year schedule (or its signed products when it has none) for the contract year running in the report's period, and in the period right after it (`nextRange()`: next year / quarter / month / same days):
  - Contract: "Licences (ARR) · this period / next period", "Services · …", "Contract value · …", "Contract year · …" (replaces "ARR in the period (licences)", same key `agreement.arr_period`).
  - Deal: the same four, "(contract)", from its contract_terms.
  - Signed product: "ARR · this/next period", "Revenue · this/next period" (`contract.arr_period` / `revenue_period` renamed, `arr_next` / `revenue_next` new).
  - Client: "ARR · this/next period", "Revenue · this/next period" (sums of its signed products).
- Column names spell the period out: "Licences (ARR) · 2026 / 2027", "Q4 2026", "Nov 2026" (`periodTag`, `withPeriodTag`); the column search also finds them by "year", "annual", "recurring", "licence".
- Checked on the real data: 61 contracts, licences 2026 = 516.728 €, 2027 = 517.165 €.
- **PORT?** Base's `src/base/pages/sales/extras/salesReportEngine.ts` (if it reads contracts per year).
- deploy: written to the Mac (cs58); user to commit

### 2026-11-05 02:45 · Enterprise · Reports: View / Preview mode, Export menu (PDF), clickable rows, client contract dates
- files: `pages/sales/extras/SalesReport.tsx` (+ `.css`), `pages/sales/extras/salesReportEngine.ts`, `pages/clients/ClientsPage.tsx`, `pages/clients/ClientWorkspace.tsx`
- **View mode**: a saved report opens in View — a cover (name, what each row is, period if used, updated date), its figures, charts and a read-only table; no toolbar, rules or column controls, and the saved-reports list folds away. A **Build / View** switch in the bar (it reads "Preview" while there are unsaved changes or the report is new); templates and new reports open in Build. A chart's pencil in View jumps to Build on that chart.
- **Export** menu (Excel, CSV, **PDF**): PDF clones the view under `<body>` (`.rp-print-root`) and prints it A4 landscape (`@media print`), whole table up to 3,000 rows.
- **Rows open what they are**: deal → `/sales?tracking=`, contract / signed product → `/clients?client=…&contract=<deal id>` (or `&products=1`), client → `/clients?client=`, company/contact → their page (focus state), project/invoice → `/clients?client=…&project=`, ticket → `/tickets?ticket=`. Unsaved changes → "Save and open / Open without saving / Cancel". The open report (mode + unsaved changes) waits in sessionStorage `rp-return` and comes back with Back.
- ClientsPage reads `?client / &contract / &products=1 / &project` (via `useLocation`); ClientWorkspace takes `focus` and scrolls to that contract or to Signed products.
- Engine: client reports always load signed products + projects (Recurring, signed value… were 0 without them). New client fields "Contract starts (first)", "Contract starts (latest)", "First signed on". Contracts (agreement) now include contracts entered on the client (client_products without deal terms), with start/sign/term/total from the lines; customer falls back to the client's name.
- **PORT?** Base has copies of `salesReportEngine.ts`, `clients/ClientsPage.tsx`, `clients/ClientWorkspace.tsx` — the engine fix applies as is.
- deploy: written to the Mac (cs57); user to commit

### 2026-11-05 01:00 · Enterprise · Settings › Interface: "Small sidebar icons"
- files: `pages/settings/SettingsPage.tsx` (+ `.css`), `framework/AppLayout.tsx`, `framework/AppLayout.css`
- New switch "Small sidebar icons": a 50 px rail with 34 px icons; when even that doesn't fit (page zoomed far in) the page icons shrink together so the whole rail stays usable. Saved per user in `profiles.prefs.dockCompact` (+ localStorage `next.dockCompact`, event `next:dock-compact`). With it on, "Always show menu labels" is off (disabled).
- **PORT?** Base has the same sidebar: `src/base/framework/AppLayout.tsx/.css` + `src/base/pages/settings/SettingsPage.tsx/.css` — the same few edits apply (the class is `rail-compact` on `.app-shell`).
- deploy: written to the Mac; user to commit

### 2026-11-05 00:40 · Enterprise · Browser tab: "Next Management" + the Next cube icon
- files: `index.html` (title, icons, theme colour), `public/favicon.svg` (now the green Next cube, was the Vite logo), new `public/favicon-32.png`, `public/apple-touch-icon.png`
- shared by both apps (one page shell); nothing in `src/` changed.
- deploy: written to the Mac; user to commit

### 2026-11-05 00:30 · Enterprise · Superadmin console, round 2: compact headers, scrolling lists, Users page, roles
- files: `pages/superadmin/SuperAdminHome.tsx`, `SuperAdminClient.tsx`, `SuperAdminCreate.tsx`, `SuperAdmin.css`, `api/superadminApi.ts`, `sql/101_sa_user_role.sql`
- **DB** `sql/101_sa_user_role.sql` (applied): `sa_roles(p_tenant)` (the company's security levels, or the built-in list) and `sa_set_role(p_user, p_level)` (sets `security_level` + `role` like Settings › Organization does; superadmin only, never another superadmin). Nothing Base uses changed.
- Sidebar: the Next cube (`NextCube`) is the logo; it no longer stays open after a click (opens on hover / keyboard focus only). The sign-in arrival lands the cube on it.
- Every console view: `Head` is now a compact dark card (totals in glass tiles on Overview, Companies, Users). Company page header much shorter (crumb above the name, tools on the same row).
- Long lists scroll inside their card: side-by-side cards take each other's height, tables keep their header on top.
- Users page: totals (people, signed in 30 d, never signed in, by company), Active / Deactivated / All, company filter, **Add user** with company picker, role, password; shows the login to copy once made. Deactivated people: a badge on the avatar instead of a line under the role.
- Roles: click anyone's role (company Users tab or the Users page) to change it.
- **IDEA→ENT** noted from Base (Orbit: merged All list, Contact | Company switch in the New panel): told the user, not implemented.
- deploy: written to the Mac; user to commit

### 2026-11-05 06:15 · Base · Deals page in Base
- files: `BaseApp.tsx` (route `/sales` → `pages/sales/sales/SalesPage`, page access key `sales`), `framework/Dock.tsx` ("Deals", the full app's chart icon, after Orbit).
- The Base copy of the Deals page (list / board / forecast, deal detail via `/sales?tracking=…`, new deal, import/export) as copied on day one — not simplified yet. Links to deals from Clients, Home and Quick create ("New deal") now open it instead of landing on Home.
- checked in the real app: /sales opens with its dock item, no errors from the page. `tsc -b --noEmit` = baseline (58 + 25).
- deploy: written to the Mac; user to commit

### 2026-11-05 04:05 · Base · Data: demo catalogue for "Brazo", linked to its clients
- data only (Supabase, tenant Brazo `076c824d-…`; no SQL file): product kind **Add-on** added.
  - Products: **Brazo Consolidation** (SaaS, yearly: Starter 6.000 · Growth 12.000 · Enterprise 22.000), **Brazo Reporting** (SaaS, monthly: Essentials 290 · Pro 590), **ERP Connector** (Add-on, one time 3.500).
  - Services: **Implementation** (by step, 18.000: Discovery 15% → Configuration 35% → Data migration 25% → Training 10% → Go-live 15%), **Consulting** (per day 750: Analysis → Workshops → Recommendations), **Customer Success** (monthly 900: Onboarding → Monthly close support → Quarterly review). Steps in `phase_blueprints` with `service_id`.
  - Clients: every project has a service (75 Implementation, 25 Consulting — `projects.service_id`; project values unchanged, they come from days × rates); `client_products`: all 100 clients on Brazo Consolidation (tier in notes, 1–3 years, auto-renew, +3%/yr, 30 days), 40 also on Brazo Reporting (monthly), 25 with the ERP Connector (one-off).
- checked in the real app: Orbit › Clients shows service, products and €/yr per client; Settings › Products & Services shows the 3 products and 3 services.
- deploy: applied in Supabase

### 2026-11-05 03:50 · Base · Services in Products & Services (+ SQL 102)
- **DB** `src/base/sql/102_base_service_billing.sql` (applied): `services.billing` text not null default 'hourly' (check upfront | by_step | monthly | hourly | daily; existing day-rate services set to daily) and `services.price` numeric not null default 0 (≥ 0). Only adds; Enterprise doesn't read them (its prices stay in `service_roles`).
- files (new): `pages/settings/baseServicesApi.ts`, `pages/settings/BaseServices.tsx`; (changed) `pages/settings/BaseCatalog.tsx`, `BaseCatalog.css`.
- One page for both: **New ▾** asks "Product or Service?"; an empty page offers the two as big choices. Products keep their in-place card; services show as cards (price, how it bills, their steps as a numbered flow) and open a **one-page pop-up**: name, steps (add / rename / reorder / remove; Enter adds the next), how it bills (Upfront · By step · Monthly · Per hour · Per day) and the price (total / monthly fee / rate). "By step": a % per step (split evenly, must add up to 100%, each step's € shown).
- Steps are stored as the service's `phase_blueprints.phases` (`services.blueprint_id`, `phase_blueprints.service_id`) — the same template Enterprise uses for project phases. A blueprint shared with other services gets a copy instead of being changed; deleting a service deletes its own blueprint. `rate_unit` follows hourly/daily.
- **IDEA→ENT**: billing models (upfront / by step / monthly) on services, if Enterprise wants them.
- checked: create → load → edit → delete through the real app's client against the DB (by step 33,3/33,3/33,4 → daily 850 with 2 steps, same blueprint; nothing left after). UI at 1440 in the sandbox. `tsc -b --noEmit` = baseline (58 + 25).
- deploy: SQL applied in Supabase; files written to the Mac; user to commit

### 2026-11-05 03:20 · Base · Products & Services: new card design
- files: `pages/settings/BaseCatalog.tsx`, `pages/settings/BaseCatalog.css`
- Product cards redesigned (still edited in place): a wash of the kind's colour with a dot grain behind the header, an initials tile in the kind's colour, the name as the title and the kind as a pill under it; billing is one switch **Monthly · Yearly · One time** with a gliding light; one price = a big hero price; several tiers = small pricing columns (3 a row on a roomy card, 2 on a narrow one — container query), "+ Add tier(s)" as a small button; delete appears on hover; the save bar slides in at the bottom only when something changed, tinted by the kind.
- Prices show formatted at rest and plain while typing (whole amount selected on focus, synchronously — a frame later lost the first key); "4.800", "4,800", "12,5" all read right.
- checked: 1280 / 1440 / 1913 with sample products (sandbox), `tsc -b --noEmit` = baseline (58 + 25), md5 on the Mac.
- deploy: written to the Mac; user to commit

### 2026-11-05 03:00 · Base · Settings › Products & Services is one simple page
- files (new): `pages/settings/BaseCatalog.tsx`, `pages/settings/BaseCatalog.css`; (changed) `pages/settings/SettingsPage.tsx` (the Catalog view renders `BaseCatalog`; card text "What you sell, its kind and its price"). `CatalogPage.tsx` stays in the folder but Base no longer opens it.
- One page of product cards edited in place: name; kind (your `crm_options` product_kind list — pick, add, rename, remove right in the menu; a rename also renames `products.kind`); billing Recurring (Monthly / Yearly) or One time; one price, or tiers with a price each. Save / Discard appear only when something changed (⌘/Ctrl+Enter saves); delete with a confirm (refused nicely if the product is in use).
- Not in Base: services & blueprints tabs, description, "where it shows up" (in proposals), commitment discounts (tier durations), calculator, multi-year terms. They are **not deleted**: a card carries them along untouched through `saveProduct` (same tables, no SQL), so Enterprise finds them.
- **IDEA→ENT**: the inline card editor could be a "quick edit" for Enterprise's catalog.
- checked in the real app (built-in browser): create with 2 tiers yearly, add a kind, rename it, save — DB rows match; test product and test kind removed afterwards. `tsc -b --noEmit` = baseline (58 + 25).
- deploy: written to the Mac; user to commit

### 2026-11-05 02:45 · Base · Orbit › Clients switches like the other views (no blip)
- files: `pages/orbit/Orbit.css`
- Clients' page had an opaque background (and Orbit faded the whole page in, header included): coming on top it hid the old list at once and the header blinked. Inside Orbit the Clients page is now see-through and the page-wide fade is gone; only its list glides in, like the others.
- checked in the real app: Companies ⇄ Clients follow the same opacity curve as every other switch (old list out by ~0.35 s, new in from ~0.28 s to ~0.8 s), no long tasks.
- deploy: written to the Mac; user to commit

### 2026-11-05 02:35 · Base · Orbit › Clients: same header card as the other views
- files: `pages/orbit/Orbit.css`
- With real data the Clients page draws its header as a floating card of its own (`.cl.fh::before/::after`, 14px from the edges, sized from the header) and my earlier padding pushed the switch 12px down: the header looked broken next to the other views. Inside Orbit that card is now off and `.cl-bar` is the very same card as `.ct-head/.co-head` (14px top, 2.6rem sides, 62px, same padding, gradient, shadow, dotted sheen).
- checked in the real app (built-in browser, 1586px): card, switch and Actions at identical positions in all four views; with the switch open the Clients tools shift and shrink, nothing overflows.
- deploy: written to the Mac; user to commit

### 2026-11-05 02:20 · Base · Orbit icon redrawn; softer animations
- files: `framework/Dock.tsx`, `framework/AppLayout.css`, `pages/orbit/OrbitSwitch.tsx`, `pages/orbit/Orbit.css`
- New Orbit icon (dock + the switch's "All"): solid centre, round orbit with a gap, satellite in the gap — the tilted-ellipse one read as a scribble at 20 px. Dock item gets its own class `k-orbit` (hover: the satellite travels once round, `ri-orbit`) instead of Contacts' tilt.
- Softer, slower motion: switch names open in 0.6 s (space first, names fade in after) and close names-first; hover intent (opens after 110 ms, closes 220 ms after leaving, and stays open if the pointer is still on it after a view change); the light glides in 0.7 s. View change: old list out in 0.28 s, new list in over 0.75 s from 0.2 s (44 px); filters/counter fade 0.6 s; Clients cross-fades 0.55 s / 0.45 s.
- checked: `tsc -b --noEmit` full repo = baseline (58 + 25); md5 on the Mac.
- deploy: written to the Mac; user to commit

### 2026-11-05 01:00 · Base · Clients without KPI cards; Orbit switch pushes the header
- files: `pages/clients/ClientsPage.tsx`, `pages/orbit/Orbit.css`, `pages/orbit/OrbitSwitch.tsx`
- Clients list (Orbit › Clients): no KPI cards above the list any more (`ClientList noKpis`) and no counter next to the switch — the figures live inside each client's workspace only. (`ClientList` keeps the cards by default; Customer success is not in Base.)
- Orbit switch: no longer opens over the search; it takes its real width as the names open, so the search, filters and the rest of the header glide to the right with it.
- checked: `tsc -b --noEmit` full repo = baseline (58 + 25); md5 on the Mac.
- deploy: written to the Mac; user to commit

### 2026-11-05 00:50 · Base · Orbit gets Clients; icon switch; client test data
- files: `pages/orbit/OrbitPage.tsx`, `OrbitSwitch.tsx`, `orbitContext.ts`, `orbitTypes.ts`, `Orbit.css`, `pages/clients/ClientsPage.tsx`, `BaseApp.tsx`, `framework/Dock.tsx`
- **Clients is now Orbit's 4th view** (`/orbit?view=clients`, only for who may open the Clients page in Page access). `/clients` (and `?client=…`) redirects there; the dock has no Clients item any more (Orbit, new orbit icon, takes the place of Contacts/Companies/People/Clients in a saved dock order). `ClientsPage` takes `orbit` (Orbit's switch + a counter pill in its header, Quick create through Orbit's New panel, re-reads after a save in it); its header is placed exactly like the others (`.ob-pane .cl.cl-ov > .cl-bar` padding) so the switch and Actions don't move between views; being a dark full page it cross-fades.
- **Switch = icons** (All: orbit, Contacts: person, Companies: building, Clients: star); pointing at it opens the names next to the icons (it opens over the search, its slot keeps the closed width). Open/closed is Orbit state shared by every view's copy; the light is placed in JS (follows the buttons as they open, glides between views).
- **DB / data** (tenant Brazo only): +100 companies (all fields), each a client (`clients` with address, dates, priority, cadence, active), `client_cs_owners` = inder (primary), `client_health` (60 green / 20 amber / 20 red), one open `projects` row each (days, rate, tax, contacts); +300 contacts (2–4 per client, all fields, assigned). Totals: 1,100 companies, 5,300 contacts, 100 clients.
- checked: `tsc -b --noEmit` full repo = baseline (58 + 25); files md5-checked on the Mac; UI at 1280 / 1913 (sample data).
- deploy: written to the Mac / data applied in Supabase; user to commit

### 2026-11-05 00:35 · Base · Orbit: switch without the router (no more jank)
- files: `pages/orbit/OrbitPage.tsx`, `OrbitSwitch.tsx`, `orbitContext.ts` (new), `pages/contacts/ContactsPage.tsx`, `pages/companies/CompaniesPage.tsx`
- Cause of the "kick": a switch was a router navigation, which re-rendered all three lists (thousands of rows) — ~180 ms blocked before the animation could start. Also the 00:20 `OrbitPage.tsx` had not reached the Mac (an older copy was there); rewritten and md5-checked.
- Now the view lives in Orbit's state (`OrbitViewContext`); the switch writes the address with `history.pushState` (Back/Forward handled by a popstate listener; router navigations to /orbit, /contacts, /companies still followed). The views are memoised (`Pane`): a switch re-renders only the title switches. Long tasks on a switch: ~180 ms → none.
- Contacts/Companies: `navigate(location.pathname + window.location.search…)` (the router's search can be behind Orbit's).
- checked: `tsc -b --noEmit` on the full repo = baseline (58 + 25), nothing new.
- deploy: written to the Mac; user to commit

### 2026-11-05 00:20 · Base · Orbit: smooth switch between All / Contacts / Companies
- files: `pages/orbit/OrbitPage.tsx`, `OrbitSwitch.tsx`, `orbitTypes.ts`, `Orbit.css`
- The three views stay mounted (the other two are mounted in the background ~1 s after Orbit opens) and are only shown / hidden: switching no longer reloads a list, shows a loader or replays the page's entrance.
- Transition: the new view's header covers the old one at once (title, search, Actions don't move); the old list fades out (0.15 s), the new one glides in from the side you went to; filters / counter fade in; the title's light glides (every view's switch follows the URL).
- Note: Orbit now reads three lists when it opens (All, Contacts, Companies) instead of one.
- tags: **IDEA→ENT** (same keep-mounted switch could serve Enterprise's paired pages)
- deploy: written to the Mac; user to commit

### 2026-11-05 00:10 · Base · Data: test data for "Brazo" (Base)
- data only (Supabase, tenant `076c824d-a676-48d3-960c-043271617108` "Brazo"; no other company touched):
  - `crm_options`: sources (Website, Referral, LinkedIn, Trade fair, Cold outreach, Partner referral) and relationship types (Prospect, Partner [is_partner], Supplier, Investor, Key account).
  - 1,000 `companies`, every column filled (legal name, VAT, reg., web, LinkedIn, phones + ext, e-mail, billing {name, email}, full address, sector, source, types, notes); 100 groups of 10 (`parent_id`), 83 partners, every company has a `partner_id`; all assigned to inder@brazo.com.
  - 5,000 `contacts`, every column filled; `company_contacts` 5,500 (5–8 contacts per company, 500 contacts in two companies); all assigned to inder@brazo.com. Facts tables refreshed by their triggers (1,000 / 5,000).
- to remove: delete the tenant's rows in `company_contacts`, `contact_assignees`, `company_assignees`, `contacts`, `companies`, `crm_options` (kinds source/relationship).
- deploy: applied in Supabase

### 2026-11-04 23:55 · Base · Data: inder@brazo.com made the company's top user
- data only (Supabase, no SQL file): `profiles` of inder@brazo.com (company "Brazo", plan Base) → `role = 'boss'`, `security_level = 'boss'`, `department = 'management'`, `is_org_superadmin = true` (was consultant). `is_superadmin` left false (platform owner only).
- deploy: applied in Supabase

### 2026-11-04 23:40 · Base · Orbit: contacts and companies in one page
- files (new): `pages/orbit/OrbitPage.tsx`, `OrbitAll.tsx`, `OrbitSwitch.tsx`, `KindSwitch.tsx`, `orbitTypes.ts`, `Orbit.css`
- files (changed): `BaseApp.tsx` (route `/orbit`; `/contacts`, `/companies`, `/people` → Orbit keeping search + state), `framework/Dock.tsx` ("Orbit", `/orbit`; a saved dock order puts it where Contacts/People was), `pages/contacts/ContactsPage.tsx`, `pages/companies/CompaniesPage.tsx`
- People → **Orbit**: title switch All · Contacts · Companies. *All* is a new merged A–Z list (server functions `contacts_list` / `companies_list`, no new SQL; falls back to reading everything on databases without them).
- One **New** panel for both: the contact/company editor shows a Contact | Company switch while the record is new; switching keeps e-mail, phone, address, notes. Quick create (New contact / New company) in every Orbit view opens it in place.
- ContactsPage / CompaniesPage: new optional props `orbit` (list inside Orbit) and `only` (Orbit's panel: just the editor); their own `?new=1` handling moved to Orbit; `navigate(location.pathname…)` now keeps `?view=`.
- unused, emptied (please delete): `pages/people/PeoplePage.tsx`, `pages/people/PeopleSwitch.tsx`, `pages/people/PeoplePage.css`
- checked: type-check of `src/base` with stubs of the kernel (no new errors); UI at 1280 / 1440 / 1913 with sample data (All, Contacts, Companies, New contact ⇄ company, open from All, search). Not checked against the real database / full repo build.
- tags: **IDEA→ENT** (Enterprise could use the merged All list and the Contact | Company switch in its New panel)
- deploy: written to the Mac; user to commit

### 2026-11-04 22:45 · Enterprise · Superadmin console: new look, dialogs, arrival from the sign-in
- files: `pages/superadmin/SuperAdminHome.tsx`, `SuperAdminClient.tsx`, `SuperAdminCreate.tsx`, `SuperAdmin.css`, `routes/AppRoutes.tsx`
- Sign-in → console: the green screen stays up while the console loads (Suspense fallback / role check = `JustSignedInHold` instead of a blank), then the console carries on from it (steps tick, the green closes into the sidebar's N, the cube lands there, cards rise in). `Shell` got a `ready` prop.
- New shared console pieces (exported from `SuperAdminHome`): `Modal` (icon, kicker, title, body, footer bar; Esc/outside closes; portal) and `useConfirm()` (styled confirmations; replaces every native `confirm()` in the console).
- Companies page: dark header card with glass totals (companies, Enterprise vs Base split, seats in use, running cost), filter All / Enterprise / Base / Disabled, activity sparkline per company, row hover in the company's colour.
- Company page: dark header card (big avatar in its colour, Active pulse, Enterprise | Base switch, seats, since, last seen, tabs inside); add user / new password are now dialogs (generate, live password rules, copy); plan change, disable and delete ask through `useConfirm`.
- New company dialog: live avatar preview, seat picks (5/10/25/50) + stepper, plan cards with their pages; after creating it opens the new company's Users tab.
- tags: **KERNEL** (AppRoutes: only what shows while the superadmin console loads; nothing Base uses changed)
- deploy: written to the Mac; user to commit

### 2026-11-04 19:00 · Enterprise · Two tiers: Enterprise + Base
- **DB** `sql/100_tenant_plan.sql` (applied): `tenants.plan text not null default 'enterprise'` (check enterprise|base) — every existing company is Enterprise; `my_plan()`; `sa_set_plan(p_tenant, p_plan)` (superadmin only); `sa_dashboard` returns `plan` per company.
- **KERNEL** `framework/PageCube.tsx` + `PageCube.css` (new): the cube + `PageLoader` + `PageCover` moved out of `AppLayout.tsx/.css` (AppLayout re-exports them, existing imports unchanged). `LoginPage` imports the cube from `PageCube`.
- **KERNEL** `authContext.ts` / `AuthProvider.tsx`: `plan` in `useAuth()`, loaded with the profile via `my_plan()`.
- **KERNEL** `routes/AppRoutes.tsx`: sign-in, reset, superadmin as before; the app itself is `TierApp` → lazy `EnterpriseRoutes` or lazy `src/base/BaseApp`. Superadmin pages and `/linkedin` are lazy too.
- `routes/EnterpriseRoutes.tsx` (new): the Enterprise page routes (moved from AppRoutes, unchanged).
- Superadmin: `api/superadminApi.ts` (`TenantPlan`, `PLAN_LABEL`, `createTenant(name, max, plan)`, `setTenantPlan`), `SuperAdminCreate` (App: Enterprise | Base), `SuperAdminClient` (Enterprise | Base switch next to the name), `SuperAdminHome` (plan pill in the company list), `SuperAdmin.css`.
- `src/base/` created: a copy of everything the Base pages need (140 files: framework, homepage, calendar, contacts, companies, clients, settings, and the sales/management modules they import), kernel imports re-pointed to `src/components`. New: `BaseApp.tsx` (routes), `pages/people/PeoplePage.tsx` + `PeopleSwitch.tsx` + `PeoplePage.css` (title switch People | Companies), Base dock = Home · Tasks · Calendar · People · Clients · Settings.
- Not changed: every Enterprise page behaves exactly as before.
- Deploy: files written to the Mac; user to commit.
