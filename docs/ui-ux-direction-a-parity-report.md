# Procura UI direction A: feature parity report

**Status:** decisions approved; defect fixes verified locally, 27 September 2026  
**Chosen direction:** A — Grouped Workspaces  
**Scope:** fix the approved existing defects first, then redesign navigation and presentation with feature parity. Production deployment is a separate approval gate.

## Approved decisions

- Primary tasks, in order: Purchase orders, Inventory, Planning, RFQs. Desktop is the primary device; both regular users retain access.
- Overview remains the landing page. Keep every existing dashboard metric and stock alert; place the four priority shortcuts above them.
- Overview, Purchase orders, Inventory and Planning and RFQs stay permanently visible. The remaining destinations use expandable groups below them.
- PO history keeps PO ID, supplier, order date, total, paid, outstanding balance, approval/payment status and shipping status visible. Invoice number/date are optional columns. Every other field remains in details; effective balance remains distinct from outstanding balance.
- The future dedicated PO detail view restores filters and selection on Back. Editing uses a dedicated form and warns before abandoning unsaved edits.
- Batch work continues after individual failures, identifies successful/failed records and retains failed selections for retry.
- Inventory edits and analytics freezing explicitly require EDITOR or ADMIN. Both regular users currently have ADMIN roles (read-only production role check on 27 September); no role changes were made.
- Fix all report findings before redesigning. New scorecard ratings use equal weights for Accuracy, Speed and Quality, explicitly confirmed by the user. Historical scores are unchanged.

## Direction A navigation map

| Navigation location | Existing destinations retained |
|---|---|
| Permanent links | Overview (`/`), Purchase orders (`/pos`), Inventory (`/items`), Planning (`/planning`), RFQs (`/rfq`) |
| Purchasing support | Suppliers (`/suppliers`), Catalogue (`/catalogue`), Approvals & payments (`/workflow`), Tasks (`/tasks`) |
| Stock movement | Stock movement (`/movement`) |
| Insights | Reports (`/reports`), Analytics (`/analytics`), Supplier scorecard (`/scorecard`) |
| Data & setup | UOM mappings (`/uom`), Import data (`/import`), Validation (`/validation`), Users (`/users`, ADMIN only) |
| Secondary / account | Unlinked PO lines (`/pos/unlinked`) from Purchase orders; Change PIN (`/change-pin`), Logout, identity and demo indicator in the account area |

This is the approved navigation plan, not an implemented redesign. The existing concept preview remains illustrative and does not demonstrate full feature parity.

## Defect phase: local implementation and verification

Changes are isolated on branch `fix/ui-parity-defects`, checkout `/home/hafiz/procura-defect-fixes`, based on `10beb1a`. They have not been merged, pushed or deployed. The original working checkout's settings and changes remain intact.

| Defect | Local result |
|---|---|
| Inventory filters and pagination | Filters now run in SQL before pagination; independent stock-ID/name filters combine correctly. The API still returns an item array, with `X-Has-More` indicating the next page. Duplicate UOM mapping rows no longer duplicate inventory rows. |
| CSV / XLSX export | Both download all matching filtered rows. XLSX is a genuine workbook with numeric value columns; CSV remains CSV. New read endpoint: `GET /api/inventory/export?format=xlsx` (or `format=csv`) with the same filters. |
| PO status / shipment feedback | Status edits make one intended status request; no unconditional approval request. Invalid data, missing POs and failed writes return errors. UI handles HTTP, JSON and network failure. |
| Workflow batches | Continue per record, retain failed selections, persist successful IDs and failed IDs/reasons, prevent duplicate batch clicks, and report partial failure accurately. |
| Scorecard | Propagate database save errors; use matching supplier/comment payload names; persist timestamp, signed-in rater and equal-weight score. Summary names/counts and paid/partial eligibility match actual API fields. |
| Item-history checkboxes | Remove the undefined onchange handler; the existing run action submits only checked items. |
| Permissions | Explicit EDITOR/ADMIN checks on inventory edits and analytics freeze. Existing authentication middleware already blocks VIEWER writes; the explicit checks also reject other unapproved roles. |
| Inventory anchors found during verification | Details now return pack size and exclusion, avoiding their accidental clearing when another field is saved. Missing item/details return errors. |

Verified locally against a freshly created disposable database, never the production database:

- `python3 scripts/check-ui-defects.py`: 16 HTTP/data checks, 6 actual UI-handler checks and 5 authenticated Chrome flows pass. This command builds the app and starts its own isolated server.
- Chrome flows: inventory filtering/edit/reload and anchor retention; shipment save and failed PO status; mixed workflow batch; item-history selection/run; scorecard save and summary. No JavaScript exceptions were observed in those flows.
- `GOFLAGS=-buildvcs=false go test ./...`: all existing Go tests pass.
- `git diff --check`: passes.

Coverage is focused on the approved defects. Full application and redesigned UI parity remain future acceptance gates; these checks are not a claim that every unrelated workflow has been exercised. Chrome checks need `google-chrome`, Node.js with WebSocket support and Python 3; no new dependencies were added.

## Implementation sequence and gates

1. Review the defect changes as a separate phase. Any merge or deploy remains explicitly separate.
2. Implement the approved navigation shell and Overview priority actions while retaining page behavior, routes and session handling.
3. Redesign PO list/details/editing and then remaining pages. Carry every row of the feature inventory forward, including optional columns and exports.
4. Complete authenticated parity checks for every page/action/role and saved-data readbacks on isolated data before production release.

## Feature parity inventory

Every row is in implementation scope if Direction A is built. A nav label can change; the route and business meaning must remain stable.

| Page | Existing features and state to preserve | Server/data boundary |
|---|---|---|
| Overview | Six summary metrics; top 10 reorder list; eight-column table; quick links to RFQ, Workflow, and Movement. | `/api/dashboard`; overview stats also come from `dashboard` service. |
| Inventory | Search by stock ID/name; supplier and category filters; low-stock and active-only toggles; reset; paged item table; CSV and displayed XLSX export controls; stock import; item detail; anchor editing for behavior, velocity, pack size, planning/ROP exclusion and reason; cost, selling price, UOM, ROP fields; recent movement and PO history. | `/api/inventory`, `/api/inventory/filter-options`, `/api/inventory/detail`, `POST /api/inventory/{stockID}`, `POST /api/import-stock`. Existing client-side filters and pagination must be preserved or intentionally repaired with checks. |
| Stock movement | Year/month/search; refresh; pagination; movement CSV export; XLSX upload preview, confirm/cancel; optional ROP recalculation after import; manual ROP recalc. | `/api/movement`, `/api/movement/years`, `/api/movement/bulk`, `/api/movement/rop`. Upload/recalc write data. |
| Planning | Search, supplier/type/category/status/on-order filters; suggested quantity edits; row and select-all selection; priority/confidence and source/freshness detail; grouped Mark Ordered; in-flight order list with Delivered/Cancel; Create RFQ handoff. | `/api/planning`, `/api/planning/orders`, `POST /api/planning/order`, `POST /api/planning/order/{deliver|cancel}`. Create RFQ hands selected data through `sessionStorage` to `/rfq`; preserve that handoff. |
| RFQs | Draft list/history; generated ID/date/supplier/notes; add/remove/edit lines; save and delete; preview and PDF; load Planning handoff. | `/api/rfq`, `/api/rfq/next-id`, `POST /api/rfq`, `DELETE /api/rfq/{rfqId}`, `/rfq/{rfqId}/preview`, `/rfq/{rfqId}/pdf`. |
| Purchase orders | Search; supplier/status/shipment filters; unpaid-only; reset; CSV export; order history and selected-order detail; preview/PDF; status, shipment and invoice-date edits including clearing the invoice date; create/edit order; department, supplier, bill reference, terms and dates; keyboard item autocomplete; supplier UOM; line quantities/costs/totals; add/remove lines; PO ID check; save; link unlinked lines and optionally remember aliases. | `/api/pos`, `/api/pos/next-id`, `POST /api/pos`, `POST /api/pos/{poId}/status`, `POST /api/pos/{poId}/invoice-date`, `/pos/{poId}/preview`, `/pos/{poId}/pdf`, `/pos/unlinked`, `/api/pos/unlinked`, `POST /api/pos/unlinked/link`; reads inventory, suppliers and UOM mappings. Preserve existing JSON field names and the Planning→RFQ→PO sequence. |
| Suppliers | Search; add/edit all existing supplier contact, payment and terms fields; preserve original name for rename updates; delete where currently allowed. | `/api/suppliers`; `POST /api/suppliers`; `DELETE /api/suppliers/{name}`. Save is EDITOR/ADMIN; delete is ADMIN. |
| Approvals & payments | Manager Approval and Finance Request tabs; PO search; select one/all; batch Approve or Request Payment; refresh; counts and success/error feedback. | `/api/pos?status=...`, `POST /api/workflow/approve`, `POST /api/workflow/payment`; writes are EDITOR/ADMIN. Batch results must report partial failures accurately. |
| Tasks | All/Pending/Done views; create/edit title and notes; mark done; reopen; delete. | `GET /api/tasks`, `POST /api/tasks`; writes are EDITOR/ADMIN. |
| Reports | Restock, closing and consumption report modes; year/month; pagination; CSV; item history search, checkbox selection and run action. | `/api/reports/restock`, `/api/reports/historical`, `/api/reports/search-po-items`, `POST /api/reports/item-history`. |
| Analytics | Date range; Finance, Operations, Inventory, Supplier and Business views; charts/tables; freeze month; XLSX export. | `GET /api/analytics`, `POST /api/analytics/freeze`, `/api/analytics/export`. Freeze is a write. Current route only requires authentication; see permission note below. |
| Supplier scorecard | Summary; pending paid/partial POs; Accuracy, Speed and Quality ratings (1–5); comments; submit. | `/api/scorecard`, `/api/scorecard/summary`, `POST /api/scorecard`; writes are EDITOR/ADMIN. |
| Catalogue | Search after 2+ characters; supplier, reference, description, price and UOM result columns. Catalogue sources exist server-side but have no current dedicated UI control. | `/api/catalogue`, `/api/catalogue/sources`. |
| UOM mappings | Supplier filter; existing item usage and conversions; create mapping with supplier, supplier UOM and standard UOM. | `/api/uom`, `/api/uom/mappings`, `POST /api/uom/mapping`; writes are EDITOR/ADMIN. |
| Import data | XLSX workbook upload; optional movement year/month; result counts/errors; Upload and Import History tabs; recent runs. | `POST /api/import`, `/api/import/history`; writes are EDITOR/ADMIN. |
| Validation | Refresh database checks; toggle nonzero-only; download Markdown report. | `/api/validation`, `/api/validation/report`. |
| Users (ADMIN) | Add/edit user email, name and role; reset PIN; delete; show issued/reset PIN response. | `/users`, `/api/users` GET/POST/PUT/DELETE, `/api/users/reset-pin`; all ADMIN only. |
| Login, account, session | PIN login; demo login; Change PIN (current and new PIN); logout; 5-minute session heartbeat; 15-minute idle logout; demo-only banner and read-only sample-data isolation. | `/login`, `POST /api/login`, `POST /api/login/demo`, `POST /api/logout`, `GET /api/session`, `/change-pin`, `POST /api/change-pin`. |

## Server and access rules to retain

- Page URLs and API URLs listed in this report are existing contracts. UI work should keep them as-is unless a separately reviewed server change is required.
- The server currently enforces EDITOR/ADMIN for most writes, ADMIN for user management and supplier deletion, and authentication for reads. At the audit baseline, anchor writes and Analytics freeze lacked explicit EDITOR/ADMIN checks in `main.go`; PO status already had those checks. A redesign must not silently broaden or narrow access. The approved defect phase adds explicit EDITOR/ADMIN checks for anchor edits and analytics freezing; preserve that corrected policy during redesign.
- Demo login is VIEWER and middleware rejects its writes. Keep the demo banner, sample-data isolation and disabled/handled write behavior.
- Preserve session heartbeat/idle logout from `templates/base.html`; moving or replacing the shell must not remove it.
- Preserve current HTML form field names and API payloads, including `invoice_date`, `po_id`, `field`, `status`, `supplier`, `movement_year` and `movement_month`.

## Existing issues found during the audit

These findings describe the original `10beb1a` audit baseline. Their evidence line numbers refer to that baseline. The approved local corrections and verification results above supersede the proposed handling in this historical table.

| Finding | Evidence | Parity risk / handling |
|---|---|---|
| Inventory filter options are applied to a single server page in the browser. The next button is based on the filtered row count, so supplier/category/low/active filtering can hide later matches. | `templates/inventory.html:111-127` | A redesign must not drop filters or falsely imply complete results. Prefer server-side filter parameters and stable pagination if inventory is changed; otherwise retain existing behavior and record it as a known limitation. |
| Inventory's `.xlsx` control calls an exporter that always builds CSV and downloads `items.csv`. | `templates/inventory.html:6-8,233-242` | Do not relabel CSV as XLSX. Either preserve the current visible behavior until a separately scoped fix, or implement a real XLSX export with explicit scope. |
| PO status UI calls approval unconditionally before status save; status/shipping calls do not inspect HTTP status or response body. Server status handler ignores `UpdateStatus` errors and returns success. | `templates/pos.html:357-375`; `main.go:492-504` | Redesign must preserve intentional status and shipment semantics and show real failures. Do not couple every status edit to Approve. Fix this write path before calling the redesigned control accepted. |
| Workflow batch action counts successes but always shows a success toast, even when some requests fail. | `templates/workflow.html:64-73` | Report success, partial success and total failure separately; verify server response for every selected PO. |
| Scorecard handler discards `scoreSvc.Save` errors and responds success. | `main.go:965-970`; `internal/scorecard/scorecard.go:44-53` | A successful-looking redesign cannot guarantee a saved score. Handle this server defect in a separately scoped fix or keep the feature acceptance gate open until fixed. |
| Item-history selector renders a call to `updateSelectedItems()`, which is not defined in the template; the run handler independently reads checked boxes. | `templates/reports.html:146` | Preserve checkbox selection and test selection changes plus report run. A checkbox interaction may log a JS error today. |
| Inventory anchor update and Analytics freeze are protected by authentication but do not use the EDITOR/ADMIN role middleware, while most write endpoints do. | `main.go:284-297,1031-1045` | Keep exactly the current server route checks in the visual port; do not assume hiding a control is authorization. Any access-policy change needs explicit scope and server tests. |

## Complete route manifest

Page routes: `/`, `/items`, `/suppliers`, `/planning`, `/pos`, `/pos/unlinked`, `/rfq`, `/movement`, `/reports`, `/analytics`, `/scorecard`, `/tasks`, `/workflow`, `/catalogue`, `/uom`, `/import`, `/validation`, `/users` (ADMIN), `/change-pin`.

API routes used by current UI and covered in the inventory above: `/api/login`, `/api/login/demo`, `/api/logout`, `/api/session`, `/api/bootstrap`, `/api/dashboard`, `/api/users` (GET/POST/PUT/DELETE), `/api/users/reset-pin`, `/api/change-pin`, `/api/inventory`, `/api/inventory/basic`, `/api/inventory/filter-options`, `/api/inventory/detail`, `/api/inventory/{stockID}` (POST), `/api/import-stock`, `/api/suppliers`, `/api/suppliers/{name}` (DELETE), `/api/planning`, `/api/planning/orders`, `/api/planning/order` (POST), `/api/planning/order/{action}` (POST), `/api/pos`, `/api/pos/next-id`, `/api/pos/unlinked`, `/api/pos/unlinked/link` (POST), `/api/pos/{poId}/status` (POST), `/api/pos/{poId}/invoice-date` (POST), `/api/rfq`, `/api/rfq/next-id`, `/api/rfq/{rfqId}` (DELETE), `/api/movement`, `/api/movement/years`, `/api/movement/timeline`, `/api/movement/rop` (POST), `/api/movement/bulk` (POST), `/api/reports/restock`, `/api/reports/historical`, `/api/reports/search-po-items`, `/api/reports/item-history` (POST), `/api/tasks`, `/api/scorecard`, `/api/scorecard/summary`, `/api/workflow/approve` (POST), `/api/workflow/payment` (POST), `/api/workflow/pending`, `/api/analytics`, `/api/analytics/freeze` (POST), `/api/analytics/export`, `/api/catalogue`, `/api/catalogue/sources`, `/api/uom`, `/api/uom/mappings`, `/api/uom/mapping` (POST), `/api/import` (POST), `/api/import/history`, `/api/validation`, `/api/validation/report`.

File routes: `/pos/{poId}/preview`, `/pos/{poId}/pdf`, `/rfq/{rfqId}/preview`, `/rfq/{rfqId}/pdf`.

## Acceptance gate before release

This report is the pre-implementation inventory, not proof of runtime parity. For a future implementation, review this checklist on an authenticated local/staging copy using isolated data before deployment:

1. Visit every page route as VIEWER, EDITOR and ADMIN; confirm grouping, active navigation, mobile navigation, Users visibility and inaccessible route behavior.
2. For every table, compare row data, sorting/filter state, pagination, empty/error states, and export contents against the existing UI. Verify the full record set is reachable where filters apply.
3. Exercise all create/edit/delete/status/import/link/freeze/approve/payment actions with isolated records. After each write, reload the page and read the saved value back from the UI/API/database.
4. Open PO and RFQ preview/PDF downloads; check item autocomplete keyboard behavior and supplier UOM; verify Planning→RFQ state survives navigation.
5. Check demo isolation, Change PIN, logout, 5-minute heartbeat and 15-minute idle expiry.
6. Resolve or explicitly accept each existing issue above. Any unverified action remains open; HTTP 200 alone is not acceptance.

## Source scope

Audited current checkout `10beb1a` (`local-master-sync-20260927`). Main route handlers in `main.go`; shared navigation/session in `templates/base.html`; page behavior and controls in `templates/*.html`; specific service error behavior in `internal/scorecard/scorecard.go`. CodeGraph was queried first; its index flagged `main.go` and `internal/auth/auth.go` as stale, so current source files were read directly. The initial audit changed no application or production state. The subsequent approved defect phase changed only the isolated local checkout and isolated test data; production remains untouched.
