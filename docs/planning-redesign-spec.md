# Planning Module Redesign — Build Spec

Decided via wayfinder map [#1](https://github.com/H4fizWasabie/procura/issues/1); decisions live in the linked tickets. This document is the build hand-off.

## Principle

**The plan proposes, humans close the loop.** Usage data in a veterinary hospital is patient-driven and unreliable; every suggestion carries a confidence tier, and thin data produces coarser treatment — never fake numbers.

## Data ownership (single-writer discipline)

| Data | Owner |
|---|---|
| `current_stock` | Daily morning import (`Actual Stock` column of Stock_Balance_History upload) |
| `rop` | Movement module |
| Velocity estimate | Planning (derived at read time) |
| Suggestions / statuses | Planning (read-time computation; nothing persisted except direct-order rows and alias memories) |

No transactional stock-editing features. Procura owns the delta knowledge: in-flight state, history-derived velocity, decision support.

## Recommendation engine

- **Trigger**: `current_stock < stored rop`. `velocity_override` replaces velocity everywhere downstream when set.
- **Velocity**: trailing 3 complete months of `out_qty + adj_out`; widens to 6 automatically when <3 active months. Monthly units end-to-end. Seasonality ignored (known limitation).
- **Confidence tiers**: HIGH (≥3 active months), LOW (widened/sparse window), MANUAL (≤1 month history or active `initial_stock_target`). Tier attaches to the quantity, shown in UI.
- **Suggested qty**: `ceil(velocity × cover_months − current_stock − incoming_pipeline)` with a single global `cover_months = 2` config knob. Result ≤0 → no number, item flagged for review. Never negative.
- **Safety stock**: lives in the trigger only — CRITICAL ⇔ `current_stock ≤ 1 month velocity`. Quantities ignore it.
- **Statuses**: CRITICAL / REORDER / REVIEW (mutually exclusive tiers). REORDER items get quantities. Zero-velocity items below ROP appear with LOW-confidence proxy qty (rop÷2) — never silently hidden.
- **ON ORDER flag**: orthogonal to tiers; composes with any. Stage badges: ON ORDER (PO) / ON ORDER (direct) / IN RFQ. Suppressed items stay visible with incoming breakdown ("20 on PO-207 · 5 direct"), excluded from buy totals, remain manually orderable.
- **Ranking**: health% `(current/rop)×100`, worst first.
- **New items**: manual `initial_stock_target` column (additive) used as target until ~3 active months accumulate.
- Dropped: FAST/MEDIUM/SLOW turnover classes, ROP÷2 proxy for velocity, pack rounding.

## Actions

Both take explicit `{stock_id, qty, uom}` payloads + supplier from the UI; Plan() only prefills. Server never re-derives intent.

- **Send to RFQ**: RFQ draft + `rfq_logs` entry (drives IN RFQ suppression) + PDF generation. Supplier is **fully manual per RFQ**, decoupled from item's registered supplier (hint only).
- **Mark ordered**: direct-order rows (`DO-YYYY-nnn` kept). Statuses: ACTIVE → DELIVERED | CANCELLED | SUPERSEDED (new additive column `superseded_by_po TEXT`). A covering PO auto-supersedes ACTIVE rows for its stock_ids. Incoming links expire from Planning after 30 calendar days; records remain available in history.

## Linkage

- **Bug fix**: `po.Item` JSON must emit `"id"` alongside `"stock_id"` (pipeline scanner reads GAS-format `"id"`; Go-saved POs are currently invisible to suppression).
- **SaveOrder**: soft enforcement — lines without stock_id saved but flagged UNLINKED; UI item picker makes linking the default path.
- **Import**: opportunistic auto-link by normalized exact name match against `items`, then `item_aliases`. Never guess beyond that.
- **Audit view** (PO module): lists open-PO lines lacking stock_id → catalogue search → confirm writes `purchase_order_items.stock_id` + `"id"` in `raw_po_json` + optional (default-on) `item_aliases` memory so each supplier name is linked once. Open POs by default, toggle for history. Links only; never creates items.
- **Legacy backfill: abandoned** (0/468 matchable). Historical gap accepted.

## Deferred (fog notes on map #1)

- Periodic-review / order-up-to trigger policy — re-evaluate after this lands.
- Structured pack-size data for MOQ/pack rounding.
- Semantic matching assist — rejected for now (lexical + human confirm suffices).
