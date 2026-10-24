# Changelog

## 2026-10-24
- [core] Server binds to 127.0.0.1:$PORT instead of all interfaces — only the same-host reverse proxy (Caddy) can reach it, so a firewall gap no longer exposes the app or demo directly

## 2026-10-14
- [po/core] Pack size follows the supplier: each PO line saves its pack (purchase_order_items.pack_qty/pack_uom, pack_size as "500/bottle"; not in raw_po_json or the PO document), picking an item prefills that supplier's latest pack from non-void POs and falls back to the item's, editing a PO shows its own line packs, and a PO only sets the item's pack size when the item has none (a failed pack lookup keeps the last one and never fails the save) — buying the same item from another supplier overwrote the item's pack size
- [core/po/inventory] pcs and unit added to the pack and supplier UOM list — items sold per piece (e.g. pill introducers) had no unit to pick

## 2026-10-12
- [analytics] Freezing a month records the last PO it saw (po_rowid; existing frozen months marked once, migration.freeze_rowid.v1); a PO entered after its invoice month was frozen counts in its PO month instead of vanishing behind the frozen figure; a month keeps its first watermark when re-frozen, so nothing is counted twice — invoice-date spend would otherwise lose every late invoice each month
- [ci] GitHub runs go vet and go test on every PR and master push (read-only token, not persisted) — Go tests only ran by hand
- [rfq/planning/po/extension] rfq_logs.closed_at: closed RFQs no longer count as incoming in Planning or as on-order for the assistant, are not suggested on new POs, and show as Closed on the RFQ list; editing an RFQ keeps it closed and startup requires the column — RFQs from September and earlier are closed so only current-month RFQs stay open
- [analytics/dashboard/po/core] Procurement spend (monthly chart, department, suppliers, PO count, Overview YTD) follows the invoice date for POs created from August 2026; an invoice dated in an earlier frozen month counts in August 2026, and a missing or implausible (over 120 days from the PO) invoice date falls back to the PO date. The frozen Aug and Sep 2026 spend is recomputed once (migration.invoice_spend.v1, marked done even where no months are frozen); earlier months are untouched. Invoice dates are normalized to YYYY-MM-DD on startup and on PO save, and unreadable or wrong-year dates are rejected — finance reports by invoice date, and typed dates like 26-9-8 or a 2027 year had crept in
- [tasks/dashboard] Pending tasks on the Overview (for you first, then for anyone, then for others; from/for/age; Done in place; quick add with an assignee; first 5 with a link to the rest), Tasks moved to the main nav with a count of your pending tasks, and tasks.assigned_to added; the server now records the creator and never overwrites creator or created date on edit, Done/Delete no longer wipe other fields, deleted tasks are hidden, and a task-list database error returns 500 instead of an empty list — tasks are how the officer and staff communicate but sat unseen on a collapsed page, and recent tasks had lost who wrote them
- [po] Picking a supplier on a new PO suggests their open RFQs (under 30 days old, no PO yet) as buttons that fill From RFQ and its lines; a saved PO marks its RFQ as used on the open form; RFQ dates in the form are escaped — RFQs left unlinked kept counting as incoming in Planning (32 open in production)
- [po/suppliers] Admin toggle on the Suppliers page (settings po.terms_auto_delivered, off by default): when on, a new PO from a supplier on day terms (14/30/60 days) starts as Delivered, and advance, COD, deposit or blank terms (or day terms that also mention paying up front) start as Pending (browser check covers "Pay in Advance; delivery in 30 days"); the form sets it on supplier pick and it stays editable, assistant drafts follow the same rule, and edits never change it — the procurement officer may receive goods on credit terms before manager approval
- [po/rfq] Optionally start a PO from an RFQ (From RFQ field or Make PO on the RFQ list): fills the supplier, offers the RFQ lines to pick into the add row, warns when the PO supplier differs, and saves purchase_orders.linked_rfq (internal only, several POs per RFQ allowed); the RFQ list shows its POs — invoices for an RFQ no longer need retyping, and planning stops counting a linked RFQ as incoming
- [rfq] Read text quantities in older RFQs (73 in production) instead of showing 0
- [rfq/po] GET /api/rfq/{id}; the PO form fetches an RFQ by id when it is older than the newest 100 the RFQ list returns (269 in production), and text quantities like "NaN" read as 0 — an older RFQ could not fill the form, and a NaN would break the RFQ list JSON
- [planning] Supplier filter is a text box with the supplier list as suggestions, matching case-insensitive partial names — a long dropdown was slow to pick from
- [inventory/core] Replace free-text pack size with pack_qty + pack_uom from a fixed unit list (box, pack, bag, bottle, carton, roll, tube, can, jar, vial, pouch, drum, gallon), set or cleared together and audited; pack_size is now derived as "12/box" for mino and older readers — free text like "100ml" or "1.0" could not be parsed or compared
- [core] Clear the 49 legacy free-text pack sizes once at startup with one audit row each — pack sizes are re-entered in the new format while ordering
- [core/po] Leave structured pack values untouched if the legacy clear retries, and keep the PO form marked unsaved when a pack update fails — review findings on #68
- [po] Enter pack size per line in the PO form and save it to the item after the PO saves (never stored on or shown in the PO); Sup.UOM becomes the same unit dropdown, saved lowercase, with unchanged pre-list values on old POs kept — uniform units instead of box/BOX/BOZ/PACLK
- [import] Stop writing workbook pack_size on new items — pack size is owned by Procura
- [extension] Edit pack size as pack_qty + pack_uom and drop unlisted supplier units from assistant PO drafts — matches the server's new validation
- [scripts] Add check-po-pack-size.mjs and send the now-required edit reason in the UI checks

## 2026-10-02
- [extension] Add assistant write tools (preview/create PO and RFQ, single and batch item edits) that call Procura's HTTP API as the restricted ASSISTANT account, with preview-then-reply confirmation, read-back verification and no retry of unclear saves; search now returns purchase policy, behaviour and exclude — Theoses drafts and classifies while approvals stay human
- [po/rfq] Require exact inventory IDs for every assistant-created line inside the create transaction — blank, unknown and mis-cased IDs cannot bypass purchase or UOM guards
- [validation/dashboard] Apply routine eligibility to the zero-stock reorder signal while retaining all-item data-quality checks, and break alert health ties by stock ID — prevent seasonal items leaking into signals and stabilize the top ten
- [movement] Recalculate ROP using stockability only after all planning views adopt shared eligibility — exclusion, purchase policy and availability toggles no longer erase the reorder point
- [planning] Share routine eligibility and strict stored-ROP thresholds across planning views, retain all-item valuation/validation and browsing-only Active filtering — consistent recommendations without hiding historical linking choices
- [po/rfq] Check purchase policy on new lines and require logged availability acknowledgement, while historical edits and direct orders remain recordable with visible warnings — separate routine suggestions from explicit purchase intent
- [po/rfq] Reject assistant availability acknowledgements and unavailable, blocked-policy or pending-UOM items during draft creation — availability overrides remain human-only
- [po/rfq] Allocate assistant draft IDs inside the insert transaction with a serialized writer lock and create-only inserts, forcing safe PO status and skipping unrelated mapping/direct-order writes — concurrent drafts cannot overwrite records
- [auth/inventory] Add the ASSISTANT permission boundary and validate known user roles — allow only draft creates and audited edits to the eight agreed item fields
- [import] Preserve item columns absent from a workbook and compare UOM only when supplied — partial sheets cannot erase prices or catalogue fields or create false UOM flags
- [inventory] Trust hospital product-type re-sync and limit the EDITOR/ADMIN check to Confirm UOM — manual type validation remains enforced without blocking other item edits
- [po/rfq] Reject newly added pending-UOM items on re-save and return 400 only for that guard — existing lines remain editable and database failures still return 500
- [inventory] Let Unclassified results bypass the Active filter and fail startup visibly when the purchase policy migration is incomplete — keeps the classification queue usable and surfaces schema errors.
- [core] Apply SQLite's busy timeout through the supported pragma DSN option — wait for transient database locks without changing journal or foreign-key behavior
- [inventory] Add an audited purchase policy with a guarded one-time legacy backfill and an Unclassified filter — keep purchase intent separate from planning exclusion

## 2026-09-30
- [po] Return empty filtered results as an array and safely handle null list responses — avoid a refresh error after saving a PO status

## 2026-09-27
- [movement] fit the movement table to the remaining viewport and keep its headings sticky while rows scroll — leaves ROP actions and period/search controls in view
- [po] Keep history controls visible while the order list scrolls, with sticky column headings — retain access to filters and actions on long lists
- [po] Require date, department, and supplier before saving POs in the form and service — prevent incomplete headers while keeping invoice fields optional
- [inventory] Filter before pagination, report load/save errors and export real XLSX or CSV for all matching rows — prevent missing results and mislabeled exports
- [inventory] Return pack size and exclusion in item details — preserve anchors when other fields are edited
- [po] Remove unintended approval calls and surface invalid, missing and failed status/shipment updates — prevent false success and side effects
- [workflow] Report per-order batch failures and retain failed selections — allow accurate retry without repeating successful work
- [scorecard] Persist supplier, comments, rater, timestamp and equal-weight ratings; report save failures and correct summary fields — make ratings reliable
- [report] Remove an undefined item-history checkbox handler — keep selection usable without JavaScript errors
- [auth] Require Editor/Admin for inventory edits and analytics freezing — apply the approved write-access policy explicitly
- [ui] Record approved direction A navigation, feature parity and defect verification — establish the implementation and release gates

## 2026-09-25
- [po] Wire Set Inv Date to a role-protected API that validates and persists invoice dates — prevent false success without updating the PO
- [uom] Prefer the matching item label when updating supplier mappings by stock ID — avoid renaming a legacy duplicate and violating the supplier/name unique constraint

## 2026-09-23
- [analytics] Normalize three butterfly needle item labels to In-House Use in production — include their movement value in future in-house analytics without changing frozen months
- [planning] Propagate incoming-pipeline query, scan, and rows.Err failures through Plan and the /api/planning route instead of returning a silent empty pipeline — a database fault now surfaces as a server error, not a false "no incoming stock" (#39)
- [import] Save each PurchaseOrder sheet row's header and lines atomically and report malformed po_data_json and SQL errors instead of counting them as imported — a failed PO row no longer overwrites its previous header/lines or inflates import_runs counts (#38)
- [planning] Wrap direct-order batch inserts and supersede updates in transactions, and rebuild the legacy single-column order_id primary key into a surrogate id — a failed row no longer leaves partial direct orders or blocks every multi-item order from ever saving (#37)
- [audit] Record the 11 Procura findings, merged fixes, and live verification — keep the review trail in the repository
- [report] Prefer exact SKU for last purchase and limit name fallback to unlinked lines — avoid another SKU's purchase history
- [analytics] Label Top 20 contributors as recalculated at current costs — distinguish them from frozen monthly chart values
- [import] Archive uploaded workbook bytes before recording the import path — make import history usable for review
- [analytics] Populate High Movers value from movement quantity and item cost — remove misleading RM0 entries
- [workflow] Report failed approval and payment transitions instead of false success — expose missing POs, wrong status, and SQL errors
- [po] Link only the selected duplicate-name line and save both PO representations together — prevent wrong SKU links
- [import] Validate monthly movement rows and replace the month atomically — preserve existing data when a reupload fails
- [po] Save the header and lines atomically and persist calculated line totals — prevent partial orders and stale raw JSON
- [auth] Validate sessions against current users and revoke them on account changes — stale roles and pre-fix demo tokens no longer retain access
- [auth] Register demo login only in demo mode — prevent credential-free access to production data

## 2026-09-20
- [analytics] Merge Medical/Ward and Ward/Medical department labels in spending reports — removes duplicate department slices without rewriting PO history
- [analytics] Separate raw month freezing from legacy baseline overlays and reconcile Total PO Spend with the displayed monthly series — preserves approved historical values while keeping live-period KPIs consistent

## 2026-09-11
- [po] Add shipping status to new/edit PO entry and treat Delivered as terminal alongside legacy Received — keeps history and planning consistent during the status migration

## 2026-09-10
- [rfq] Expand generated RFQ documents from 15 to 20 item rows — items 16–20 now appear in preview and PDF
- [rfq] Sort same-day RFQs by generated sequence descending — newest requests now stay at the top
- [analytics] Freeze months from raw movement data — an existing zero or stale snapshot can no longer reproduce itself

## 2026-09-10
- [po] Show full item names in the new-PO autocomplete — replaced the clipped native datalist with a searchable, keyboard-friendly dropdown
- [planning] Keep the Planning filters compact and sticky while scrolling, and exclude items at or above 100% health from reorder recommendations
- [planning] Keep the Planning table header sticky beneath the filters while scrolling
- [planning] Parse timestamped direct-order dates correctly — stale ages no longer display as 106751 days
- [planning] Include direct-order status in the Planning API — stale orders now expose Delivered and Cancel actions

## 2026-09-07
- [demo] Auto-login after the real login page redirects to the demo — visitors no longer see a second email/PIN form
- [demo] Added an isolated demo mode with seeded sample data, configurable SQLite directory/port, and demo-button routing — public visitors no longer need access to the real database

## 2026-09-06
- [planning] Expire PO, RFQ, and active direct-order links from Planning after 30 calendar days; stale links no longer suppress fresh recommendations while history remains

## 2026-08-25
- [auth] Added a 15-minute sliding idle timeout — active requests refresh the session; inactive browser sessions expire and return to login
- [auth] Added a five-minute visible-page heartbeat so users can complete long forms without losing an active session

## 2026-08-25
- [rfq] Added Edit action for generated RFQs, reusing the existing form and preserving the RFQ date on save

## 2026-08-12
- [repo] OSS prep — removed legacy gas/ folder (dead GAS code containing personal emails), bootstrap admin email now from PROCURA_ADMIN_EMAIL env (default admin@procura.local), added README + MIT license

## 2026-08-12
- [auth] JWT secret now from PROCURA_SECRET env var (fallback: new dev-only value) — the old hardcoded secret was exposed in the public GitHub repo, letting anyone forge admin tokens; VPS got a fresh random secret

## 2026-08-12
- [auth] Hide Users nav link from non-admin roles — demo/VIEWER no longer sees it (page was already 403)

## 2026-08-12
- [uom] Dedupe item-usage join — 3 suppliers had duplicate uppercase (supplier,UOM) conversion rows, inflating the item list 478→504

## 2026-08-12
- [uom] UOM page now also lists item-level usages (478 supplier_item_mappings) joined to standard UOM via case-insensitive supplier+UOM match — shows which items carry each supplier unit

## 2026-08-12
- [uom] Fix UOM page showing garbage — it fetched item-level /api/uom/mappings but rendered conversion columns (standard_uom/multiplier never existed in that payload); page now shows the 108 supplier→standard conversions from /api/uom, modal saves conversions via SaveUOM, dead mappings route removed

## 2026-08-12
- [catalogue] Fix blank catalogue page — template read old JSON keys (supplier/name/cost/bonus), API emits supplier_name/supplier_item_name/indicative_price; page now auto-loads the first 200 items on open instead of demanding a search

## 2026-08-12
- [tasks] Fix Done/Reopen/Delete/Edit dead buttons — frontend sent JSON key `id` but Go struct read `task_id`, so saves wrote NULL PK and failed silently; struct now exposes `id`, Save auto-generates TK-* id + created_date, and main.go surfaces Save errors
- [catalogue] Fix blank catalogue items on VPS — NULL supplier_item_code (and NULL deal numbers) aborted row scans mid-way, blanking every field after column 3; queries now COALESCE NULLs

## 2026-08-12
- [scorecard] Fix scorecard summary JSON key avg_score → avg — frontend read s.avg, so every summary row threw TypeError on toFixed

## 2026-08-12
- [auth] Demo login button — no-PIN POST /api/login/demo mints a VIEWER token; VIEWER role is now enforced read-only in Middleware (all non-GET blocked except item-history report and change-pin); /users page admin-only — lets visitors browse the app without credentials or write access

## 2026-08-11
- [analytics] Export Excel now covers every chart/KPI in the Analytics tab: added KPIs, Department Spend, Product Types, Supplier Ranking, Scorecard Radar, and Seasonal Trends (top 5 items × month) sheets; Summary keeps monthly trends

## 2026-08-10
- [analytics] Freeze Month button: snapshots all four monthly trends (in-house, valuation, consumption, revenue) for the selected month into the `settings` table — no more hardcoded Go maps; settings override the legacy GAS baselines. Refactored item/movement scanning into shared helpers (`loadItems`, `scanMovements`)
- [analytics] Export Excel button: downloads xlsx of the visible range — Summary + In-House Items, Consumption Items, Top Turnover, Top Movers, Critical Items, Top Suppliers, Dead Stock sheets
- [analytics] Frozen July 2026 in-house consumption baseline at 20851.69 (live value captured from VPS) — prevents retroactive changes once month data settles

## 2026-08-03
- [rfq] Item name field now autocompletes from inventory (native datalist, match by name or stock ID → auto-fills stock ID + UOM); free text still allowed for new items not in inventory. `/api/inventory/basic` now also returns UOM + supplier

## 2026-08-03
- [planning] Added filter bar (supplier, product type, category, status dropdowns + search), GAS-style; select-all now respects active filters; empty-state row added
- [rfq] Added search (RFQ ID/supplier) and supplier dropdown filter to RFQ history list

## 2026-07-29
- [planning] Aligned turnover rate, velocity thresholds, and cap months with GAS/Python: turnover = annual total_out / avg(report_closing) for most recent year (was lifetime sum); thresholds 0.50/0.10 (was 12/4); caps 1.5/1.5/2.0 months (was 4/3/2). Go planning now matches procurepilot Python output

## 2026-07-28
- [movement] Rewrote `RecalcROP()` to match GAS v3 weighted-velocity algorithm: recency buckets (0-2mo 50%, 3-5mo 30%, 6+mo 20%), velocity_override support, Service/Exclude skip, 36-month lookback, CEIL rounding. Was: simple `AVG(usage)*2`
- [planning] Fixed `createRFQ()` — supplier now carried per-item into RFQ draft; mixed-supplier warning added
- [rfq] Fixed race condition: `openCreateWithDraft()` wasn't awaiting `openCreate()`, causing draft items to be wiped by the async `tbody.innerHTML=''` call
- [rfq] Fixed qty input: `step="1"` → `step="0.01"` so fractional quantities (e.g. 2.5 boxes) are editable
- [pos] Fixed `poDetail is not defined` JS error — `selectPo()` referenced undefined variable instead of `document.getElementById('po-detail')`
- [pos] Fixed `Cannot read properties of null (reading 'map')` when filtering POs — backend `List()` returned `nil` on DB error, now returns empty slice; frontend `allPos.map` also guarded with `(allPos||[])`
- [import] Added `ImportStock()` — dedicated daily stock balance import matching Python `items_screen._import_stock_excel`: reads first sheet, fixed columns D (SKU Code) and K (Actual Stock), updates `items.current_stock`. New `POST /api/import-stock` endpoint. Fixed inventory page "Import Stock" button to use this endpoint.
- [import] Rewrote inventory header matching to use GAS-style substring containment instead of exact map lookup. Multi-word headers like "Qty On Hand" now correctly match patterns. Added `headers_found` diagnostic.
- [import] Fix stock balance history report import returning 0 rows — two root causes:
  1. Sheet names were hardcoded (DB_Items, Movement 2024/2025/2026). Now uses flexible discovery:
     - Inventory: tries DB_Items, then any sheet with "item"/"inventory"/"stock"/"balance" in name, then first sheet
     - Movement: matches any sheet containing "movement" (case-insensitive), extracts year from name
  2. Header names were hardcoded (stock_id, item_name, current). Added inventoryAliases map ported from GAS PARSER_CONFIG.INVENTORY_MAP — now recognizes "SKU Code"→stock_id, "Product Name"→item_name, "Balance"→current, and 40+ other common aliases
  - Added wide-format movement support (GAS-style: one row per item, months as column blocks) alongside existing long format
  - Added `sheets_found` diagnostic to import response and UI

## 2026-07-27
- [pdf] New `internal/pdf` package — renders PO and RFQ as HTML with PDF generation via wkhtmltopdf or Chrome headless. Preview/download routes: `/pos/{id}/preview|pdf`, `/rfq/{id}/preview|pdf`.
- [pdf] PO template: traditional pre-printed form, 20-row items table, single A4.
- [rfq] RFQ PDF: removed fixed container, matched PO margins, natural footer flow.
- [po] Fixed `POST /api/pos/{id}/status` — now reads `field` param so ship status updates correct column.
- [po] Fixed `UnmarshalJSON` to detect short-format items without `id` key.
- [ui] All date inputs changed to DD/MM/YYYY text fields (PO + RFQ forms).
- [ui] PO detail panel and RFQ list: Preview and PDF download buttons.
- [deploy] VPS: installed wkhtmltopdf 0.12.6.1 static binary.

## 2026-07-26
- [ui] Reworked the shared application shell with grouped sidebar navigation, responsive mobile drawer, page context header, user utility footer, and stronger visual hierarchy — to make the growing module set easier to scan and navigate.
- [po] Persisted supplier UOM on PO lines and reused it as the supplier-item mapping for future orders — to support ordering in supplier units without adding quantity conversion.

## 2025-07-22
- [validation] New validation module — cross-references items/movements/POs for 6 issue types (missing movements, orphans, negative stock, zero-stock-with-ROP, duplicates), with markdown export
- [import] Import history API + UI tab showing last 50 runs with per-table row counts
- [items] Upgraded inventory UI to PySide6 parity — filter bar (stock ID, name, supplier/category dropdowns, low-stock/active toggles), item detail panel with movement+PO history, anchor editor with reason field, export buttons, import stock button
- [pos] Upgraded PO UI to PySide6 parity — 2-tab layout (History/New PO), detail panel with summary grid + ship/status/invoice-date row + effective balance, edit-selected loads into New PO form, CSV export, supplier terms auto-fill, item search with datalist
- [movement] Upgraded movement UI to PySide6 parity — year/month pickers, pivot table with month columns + summary columns, existing-data check before upload, auto-ROP toggle
- [reports] Upgraded reports UI to PySide6 parity — 2-tab layout (General/Item History), metric type selector, month pickers, paginated totals, PO item search for history, CSV export
- [api] New endpoints: /api/validation, /api/validation/report, /api/import/history, /api/inventory/filter-options, /api/inventory/detail, /api/reports/search-po-items

## 2026-07-19
- [ui] Complete UI parity — 7 new pages (analytics, scorecard, tasks, workflow, catalogue, uom, import), modal upgrades (inventory/PO/RFQ), movement upload+analysis with Chart.js, dashboard quick actions, reports item history, shared CSS (modals/forms/tabs/charts)
- [movement] Added Timeline, ItemDetail, BulkSave API endpoints for movement analysis and upload
- [spec] UI parity gap closure design doc — 5-phase plan for 7 new pages + existing page upgrades

## 2025-07-19
- [core] Project initialized — Go module, AGENTS.md, architecture decisions
- [skeleton] Auth (bcrypt PIN + JWT, 3-strike lockout), Dashboard (PO scan, ROP alerts), Inventory (list/search/anchors) — working end-to-end with templates
- [suppliers] Full CRUD — create, update (with rename via original_name), delete (admin-only), search, sort by name
- [planning] Full GAS business logic — tiered ordering (FAST/MEDIUM/SLOW velocity classes), safety stock triggers, pipeline exclusion (open POs, recent RFQs, active direct orders), surgical/excluded/service filtering, direct order creation with DO-ID sequencing
- [po] PO CRUD, ID generation (PO-MMYYYY-NNN), status/ship_status updates, item JSON packing, filter/search/unpaid-only listing
- [rfq] RFQ CRUD, ID generation (RFQ-MMYYYY-NN), history, delete
- [movement] Read by year/month/search, ROP recalculation, years listing
- [report] Restock report, historical closing stock/consumption reports with pagination, item history lookup from PO data
- [tasks] CRUD list/save/delete
- [scorecard] Supplier performance entries, summary by supplier
- [workflow] Approve, request payment, mark shipped, pending actions count
- [analytics] Full GAS executive metrics — frozen baselines, department spend, in-house consumption, high movers, dead stock, supplier radar, seasonal trends, product type split
- [catalogue] Supplier catalogue items with search/filter, catalogue sources list, deal parsing
- [uom] Supplier→standard UOM normalization (108 conversions), supplier item mappings (447 records)
- [import] Excel workbook upload via excelize — imports DB_Items, DB_Suppliers, PurchaseOrder with items, Movement sheets
- All 15 modules wired with HTML pages and API endpoints
- All modules wired with HTML pages, full GAS feature parity across 11 modules

## 2026-08-23
- [planning] Full redesign per docs/planning-redesign-spec.md (wayfinder map #1): velocity from trailing 3→6 month movement history with HIGH/LOW/MANUAL confidence tiers; suggested qty = ceil(velocity×2mo cover − on_hand − incoming); CRITICAL/REORDER/REVIEW tiers; ON ORDER flag with stage badges replaces hard pipeline hiding; direct orders gain DELIVERED/SUPERSEDED lifecycle (superseded_by_po column) with supersede-on-PO hook — why: old engine produced no quantities for REORDER items and ordered items kept reappearing because Go-saved PO JSON was invisible to pipeline scanning
- [po] Item.MarshalJSON now emits GAS-format "id" alongside "stock_id" — fixes pipeline suppression missing all new POs; added linkage audit (UnlinkedLines/LinkLine/RememberAlias) writing stock_id into rows and raw_po_json
- [import] PurchaseOrder sheet auto-links empty stock_ids via normalized name match against items then item_aliases — human links teach future imports
- [core] additive migrations: items.initial_stock_target, direct_orders.superseded_by_po
- [ui] planning page: editable suggested qty, confidence/status badges, in-flight section with Delivered/Cancel actions; new /pos/unlinked audit page; removed dead POST /api/planning/rfq (server-side re-derivation violated explicit-payload contract)

## 2026-08-23 (later)
- [movement] RecalcROP persists weighted velocity to new items.velocity column; spike cap bounds each month's contribution at 3x median active month (#9, #12: first tests for RecalcROP math); plannable filter now shared with planning (#14)
- [planning] Plan() reads items.velocity instead of recomputing from calendar windows — single velocity model, no movement-table scan per plan render; confidence tiers derive from data coverage; added DataThrough() staleness label shown on planning page

## 2026-08-24
- [po] fix Item JSON round-trip: UnmarshalJSON misread new-format entries (which carry both "id" and long keys) as GAS compact format, showing empty item names and zero quantities when viewing saved POs — data was intact, read path only
- [uom] UpsertItemMapping: TRIM-tolerant lookups + INSERT falls back to UPDATE on UNIQUE conflicts — whitespace-variant legacy mappings no longer fail every PO save with "supplier UOM mapping failed"
## 2026-08-26
- [import] Make Stock Balance History uploads authoritative: header-map catalogue fields, update existing items, and add new SKUs such as Renadyl.

## 2026-09-27
- [rfq] add typeable supplier suggestions with substring, ordered-character and typo matching; require choosing an existing supplier and retain it on edit — prevents unmatched text being saved as a supplier
- [ui] implement direction A with five priority navigation links, grouped supporting workspaces, lighter work surfaces and Overview shortcuts — makes frequent procurement work easier to reach while retaining every destination and server contract.
- [po] separate list, details and editing; retain filters/selection, optional invoice columns, all detail fields, unsaved-change protection and full CSV data — reduces table density without removing information or actions.
- [po] replace destructive order replacement with an upsert that preserves payment totals, balance, workflow status and RFQ linkage during edits — prevents existing metadata from being lost when saving the redesigned form.
- [ui] restore the Unlinked Lines template dispatch and handle empty results — the retained linking route now renders its existing controls correctly.
- [ui] add authenticated direction A checks for every operational route, PO editing/readbacks, Planning→RFQ, desktop/mobile navigation and role/demo isolation — makes the approved redesign verifiable on disposable sample data.

## 2026-09-28
- [po] make PO history rows selectable and expose per-order Preview and Print / PDF actions in the list — restores easy order selection and access to document output.
## 2026-10-02
- [inventory] Validate item edits, audit changed fields atomically with user and reason, and keep edits from changing upload timestamps — preserves a reliable last-seen stock import marker.
- [inventory] Enforce Service/Asset ROP rules for stored behaviour, reject unknown edit fields, and format audit floats without exponent notation — keeps direct API edits consistent and explicit.
- [import] Share item upsert across both uploads, preserve Procura-owned status/type, refresh hospital shadows, and flag UOM changes — keeps daily reports from undoing purchasing decisions.
- [inventory] Add audited status/type edits, re-sync, and explicit UOM confirmation; surface pending and stale imports in validation — makes ownership and review visible.
- [po/rfq/planning] Block pending-UOM PO and RFQ creation and warn after recording direct orders — prevents new unit mistakes without losing existing order records.
