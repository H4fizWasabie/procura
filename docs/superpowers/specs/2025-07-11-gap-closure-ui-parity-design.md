# Feature Parity Gap Closure — UI Design Spec

**Date:** 2025-07-11
**Goal:** Achieve 100% feature parity between procura Go web UI and GAS ProcurePilot, keeping server-rendered pages with JS-driven modals.

---

## Architecture

Server-rendered Go `html/template` pages with embedded `<script>` blocks. Each page fetches data from `/api/*` endpoints via `fetch()`. Modals use the pattern already proven in `suppliers.html`: a fixed `<div>` overlay with a card + form, shown/hidden by JS. No SPA framework, no new dependencies. Chart.js loaded from CDN for analytics/movement charts only.

### Shared patterns across all pages:
- **Modal:** `<div class="modal">` → `<div class="modal-content">` → header/body with form
- **Toast:** `toast(msg, ok)` — already exists in all pages
- **Escape:** `esc(s)` — HTML entity encoding, already exists
- **CSS:** Add `.modal`, `.modal-content`, `.modal-header`, `.modal-body`, `.form-group`, `.form-row` to `style.css`

### Navigation
Add 7 links to `base.html` nav: Analytics, Scorecard, Tasks, Workflow, Catalogue, UOM, Import. Register matching `GET /<route>` handlers in `main.go` that serve `base.html` with the correct `ContentBlock`.

---

## Phase 1: Foundation

### 1.1 Shared CSS additions (`static/style.css`)
- `.modal` — fixed overlay, flex centering, z-index 99, background rgba(0,0,0,0.6)
- `.modal-content` — max-width 640px, max-height 90vh, overflow-y auto, border-radius 8px
- `.modal-header` — flex, space-between, padding, border-bottom
- `.modal-body` — padding, form groups
- `.form-group` — margin-bottom 12px
- `.form-group label` — block, font-size 11px, uppercase, color muted, margin-bottom 4px
- `.form-group input, .form-group select, .form-group textarea` — width 100%, padding 8px, border-radius 6px
- `.form-row` — display flex, gap 10px
- `.btn-group` — flex, gap 8px, justify-content flex-end
- `.btn-danger` — background var(--red)
- `.btn-secondary` — background var(--border), color var(--text)

### 1.2 Navigation (`templates/base.html`)
Add nav links after Reports: Analytics, Scorecard, Tasks, Workflow, Catalogue, UOM, Import.
Add content block routing for: content_analytics, content_scorecard, content_tasks, content_workflow, content_catalogue, content_uom, content_import.

### 1.3 Routes (`main.go`)
Add 7 `GET /<route>` handlers. All modules already have services instantiated.

---

## Phase 2: Upgrade prompt() Pages → Modals

### 2.1 Inventory (`templates/inventory.html`)
**Current:** Table + `prompt()` for editing behaviour/exclude/ROP.
**Target:** "Edit" button opens modal with:
- Stock ID (readonly), Item Name (readonly)
- Cost (editable number)
- ROP (editable number)
- Current Stock (readonly)
- Item Behaviour dropdown: Standard/Pack, Service, Asset, In-House Use, Unavailable
- Exclude checkbox
- Save/Cancel buttons, calls `POST /api/inventory/{stock_id}`

### 2.2 Purchase Orders (`templates/pos.html`)
**Current:** Table + `prompt()` for single-item creation and status-only editing.
**Target:**
- **New PO modal:** PO ID (auto), Date picker, Supplier dropdown, Department text, Line Items table (stock_id, name, qty, uom, cost, total + add/remove rows), Save button → `POST /api/pos`
- **Edit PO modal:** Readonly header (PO ID, date, supplier, dept), Status dropdown (Pending Approval/Approved/Pending Payment/Paid/Partial/Void), Ship Status dropdown, Invoice Date field, Approval button, Payment Request button → `POST /api/pos/{id}/status` + workflow calls
- Line items display (readonly in edit mode)

### 2.3 RFQ (`templates/rfq.html`)
**Current:** Table + `prompt()` for creation.
**Target:** New RFQ modal with:
- RFQ ID (auto), Date, Supplier dropdown (from /api/suppliers)
- Items table (stock_id, name, qty, uom) with add/remove
- Notes textarea
- Save → `POST /api/rfq`

---

## Phase 3: New Pages

### 3.1 Tasks (`templates/tasks.html`)
- Card grid layout (CSS grid, 340px min columns)
- Filter: All / Pending / Done buttons
- New Task button → modal with title, notes fields
- Each card: title, notes preview, created date, status badge
- Actions: Mark Done/Reopen (`POST /api/tasks` toggle), Edit, Delete
- **Skipped:** File attachments, PDF export (add when needed)

### 3.2 Scorecard (`templates/scorecard.html`)
- Table: PO ID, Supplier, Date, Bill#, Amount, Rate button
- Rate modal: PO info header, Accuracy/Speed/Quality range sliders (1-5), Comments textarea
- Submit → `POST /api/scorecard`
- Summary row showing average scores

### 3.3 Catalogue (`templates/catalogue.html`)
- Search bar + button → `GET /api/catalogue?search=...`
- Table: Supplier, ID/Ref, Description, Price, Bonus/Tiers
- "Copy to PO Draft" button → JS stores in localStorage for PO page to pick up

### 3.4 UOM (`templates/uom.html`)
- Supplier filter dropdown → loads mappings
- Table: Supplier UOM → Standard UOM, Item mappings
- Add Mapping modal: supplier, supplier_uom, standard_uom
- Save → `POST /api/uom/mapping`

### 3.5 Import (`templates/import.html`)
- File input (accept .xlsx), upload button
- POST multipart to `/api/import`
- Result display: run_id, tables count, rows imported

### 3.6 Workflow (`templates/workflow.html`)
- Two tabs: Manager Approval / Finance Request (like GAS sub-tabs)
- Table: checkbox, PO ID, Supplier, Dept, Amount, Docs column
- Batch select + action buttons
- Document upload: signed PO PDF, invoice PDF (per PO row)
- **Skipped:** Email composition UI (email logic was cut per AGENTS.md). Approval/payment actions call API directly.

### 3.7 Analytics (`templates/analytics.html`)
- Date range selectors (from month/year → to month/year)
- 5 sub-tabs: Finance, Operation, Inventory, Supplier, Business Insight
- KPI cards at top per tab
- Chart.js bar/line/doughnut/radar charts per tab
- Tables for rankings (top suppliers, critical items, dead stock)
- Data from `GET /api/analytics?from_year=...&from_month=...&to_year=...&to_month=...`
- **No AI summary buttons** — removed per user preference

---

## Phase 4: Feature Depth on Existing Pages

### 4.1 Dashboard
- Add Quick Actions card: buttons linking to RFQ, Workflow (approval), Movement
- Keep existing stats cards + ROP alerts table
- Add animated counters (optional, low priority)

### 4.2 Movement — Upload Tab
- Year/month selector (existing)
- Upload mode: Movement Flow (in/out/adj) or Closing Balance
- Paste textarea (tab-delimited from Excel)
- Parse → preview staging table
- Confirm → `POST /api/movement` bulk save
- **Need API:** Bulk movement save endpoint (or reuse import module)

### 4.3 Movement — Analysis Tab (MovTools)
- Left panel: infinite-scroll item list with search
- Right panel: selected item analysis
  - Item name, stock ID, category header
  - Stats cards: Total IN, Total OUT, Capital Cost, Sales Revenue, Gross Profit
  - Chart.js line chart: IN/OUT/Closing over time
  - Date range filter
- **Need API:** `GET /api/movement/item-history?stock_id=...` returning timeline data with item cost/selling price

### 4.4 Reports — Item History
- Add item history section to reports page
- Multi-select item picker → `POST /api/reports/item-history`
- Table with monthly breakdown per selected item

---

## Phase 5: Polish

- Loading spinners on fetch calls (CSS animation existing)
- Disabled button states during save
- Form validation (required fields highlighted)
- Empty state messages (no data, no results)
- Responsive grid: collapse to single column on small screens

---

## Files Changed/Created

| File | Action |
|------|--------|
| `static/style.css` | Add modal + form styles |
| `templates/base.html` | Add 7 nav links + 7 content blocks |
| `main.go` | Add 7 page routes |
| `templates/inventory.html` | Replace prompt() with modal |
| `templates/pos.html` | Replace prompt() with create/edit modals |
| `templates/rfq.html` | Replace prompt() with create modal |
| `templates/dashboard.html` | Add Quick Actions card |
| `templates/movement.html` | Add upload tab + analysis tab |
| `templates/reports.html` | Add item history section |
| `templates/tasks.html` | **Create** — card grid + CRUD modal |
| `templates/scorecard.html` | **Create** — pending list + rating modal |
| `templates/catalogue.html` | **Create** — search + table |
| `templates/uom.html` | **Create** — mappings editor |
| `templates/import.html` | **Create** — file upload |
| `templates/workflow.html` | **Create** — batch approval/payment |
| `templates/analytics.html` | **Create** — 5-tab BI dashboard |

---

## APIs to Add (if missing)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/movement/bulk` | Save staged movement data for a year/month |
| `GET /api/movement/item-history?stock_id=X` | Timeline data for one item over all months |
| `GET /api/movement/item-detail?stock_id=X` | Item cost, selling price, category for analysis |

Existing APIs for all other modules are already registered in `main.go`.
