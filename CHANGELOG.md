# Changelog

## 2026-09-10
- [po] Show full item names in the new-PO autocomplete — replaced the clipped native datalist with a searchable, keyboard-friendly dropdown

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
