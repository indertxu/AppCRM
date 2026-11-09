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
Next free number: **118**  ← update this line when you claim one (and say which file in the log).
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

## 8. Requests between the chats
Write requests here; the other chat answers in the log and ticks them.
- [ ] _(none yet)_

---

## 9. Change log
Newest first. Format: `### YYYY-MM-DD HH:MM · Chat · title` then bullets: files, what changed, tags (**KERNEL / DB / PORT? / IDEA→ENT**), deploy state.

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
