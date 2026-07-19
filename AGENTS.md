# Procura

Go rewrite of ProcurePilot — a procurement management system. Replaces the Google Apps Script (GAS) + Python hybrid with a single Go binary deployable to VPS.

## Architecture

Single binary with embedded templates and static files. Each module is an independent Go package under `internal/`. Modules communicate through explicit interfaces — no shared global state. One broken module must not affect others.

### Module inventory (keep)

| Module | Source | Purpose |
|--------|--------|---------|
| core | new | Config, DB connection pool, logging |
| auth | GS_Auth.js | Simple PIN + JWT authentication |
| dashboard | GS_Dashboard.js | Home page summary stats |
| inventory | GS_Inventory.js + Python | Items CRUD, search, pagination, item history, anchor fields |
| suppliers | GS_Suppliers.js | Supplier CRUD |
| po | GS_PurchaseOrder.js + Python | Purchase orders, line items, invoice date field |
| movement | GS_Movement.js | Stock movements, ROP recalculation |
| planning | GS_Planning.js | What-to-buy recommendations |
| rfq | GS_RFQ.js | RFQ draft creation and history |
| report | GS_Report.js + Python | Metric reports, item history report, weekly report |
| analytics | GS_Analytics.js + Python | Executive dashboard metrics, frozen baselines |
| tasks | GS_Tasks.js | Task tracking |
| workflow | GS_Workflow.js | Approval flows (no email) |
| scorecard | GS_Scorecard.js | Supplier performance ratings |
| catalogue | Python | Supplier catalogue import, deal parsing |
| uom | Python | Supplier→standard UOM normalization, item mappings |
| import | Python | Excel workbook upload → DB |

### Module inventory (cut)

- **GS_AI.js / GS_AgentDataIntelligence.js** — AI chat, agent intel
- **GS_Admin.js** — Admin panel
- **GS_Invoice.js** — Invoice management
- **GS_Triggers.js** — GAS cron triggers
- **GS_Tests.js** — GAS tests
- **GS_Catalogue.js** — Replaced by Python catalogue module
- **PRF / order_requests** — Purchase request forms
- **All email logic** — Stripped from workflow, PO, and auth modules

## Database

SQLite at `data/procura.sqlite`. Schema contract shared with **mino** (AI procurement agent on VPS). The Go app and mino read/write the same database.

**Existing tables preserved for mino:**
items, suppliers, purchase_orders, purchase_order_items, stock_movements, rfq_logs, direct_orders, supplier_performance, tasks, invoices, incoming_docs, order_review, import_runs, import_run_tables, movement_edit_audit, item_anchor_audit, settings, catalogue_*, supplier_uom, supplier_item_uom, supplier_item_mappings, analytics_config, legacy_monthly_baselines, item_aliases, order_requests

**New tables:**
- `users` — email, bcrypt_pin, role, name, department
- `logs` — timestamp, user, action, module, context, details

**Dropped:** order_requests table. Invoice module data stays (mino may use historical invoice records) but no new invoice features.

## Rules

1. **Least code to solve the problem.** Less code = fewer bugs. No abstractions without a concrete second use case. No interfaces with one implementation. Stdlib first, then well-known dependencies.

2. **CHANGELOG.md on every change.** After any code adjustment, bug fix, or feature addition, append to CHANGELOG.md. Format:
   ```
   ## YYYY-MM-DD
   - [module] what changed — why
   ```
   The pre-commit hook enforces this.

3. **Modular isolation.** Each `internal/` package is self-contained. Dependencies injected via interfaces. If one module fails at startup, others still serve. Go's `net/http` recovers panics per-request.

4. **Respect the schema contract.** Tables that mino reads/writes must keep their structure. Adding columns is fine. Renaming or removing requires checking with mino first.

5. **Frontend.** Port GAS HTML modals into combined full pages. Lighter dark theme — slate grays, not pure black. Server-rendered with Go `html/template`.

## Startup order

1. Auth + Dashboard + Inventory — skeleton: DB → Go → HTML → browser
2. Suppliers + PO + Movement — core data modules
3. Planning + RFQ + Report — business logic
4. Analytics + Scorecard + Workflow — advanced features
5. Catalogue + UOM + Import — secondary modules

## Tech stack

- Go 1.22+ standard library (`net/http`, `html/template`, `database/sql`, `embed`)
- `modernc.org/sqlite` — pure Go SQLite driver (no CGO)
- `github.com/xuri/excelize/v2` — Excel import
- `golang.org/x/crypto/bcrypt` — PIN hashing
- `github.com/golang-jwt/jwt/v5` — JWT tokens
