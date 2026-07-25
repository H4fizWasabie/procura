# Changelog

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
