# Context: Procura

Glossary only — no implementation details. Domain language for the procurement system.

## Terms

- **Velocity** — estimated consumption rate of an item, derived from stock movement history. Drives reorder triggering and quantity suggestions.
- **Confidence tier** — data-quality tag attached to every suggested quantity: HIGH (solid history), LOW (thin/sparse history), MANUAL (too little history to estimate; human supplies the quantity).
- **Velocity override** — a manually supplied velocity for an item that replaces the estimated one. Everything downstream derives from it as if it were estimated.
- **ROP (reorder point)** — the stock level at which an item triggers reordering. Owned by the movement module; planning reads it, never writes it.
- **Target stock** — the stock level planning aims to restore when suggesting a quantity: velocity × cover period.
- **Cover period** — how many months of usage a replenishment aims to provide. A single global setting, not per-item.
- **Incoming pipeline** — quantity of an item already being procured (open POs, active direct orders, recent RFQs) that reduces what still needs ordering.
- **ON ORDER** — flag on an item that has incoming pipeline. Orthogonal to status tiers: an item can need ordering and be partially covered at once.
- **CRITICAL** — item at or below its safety level; most urgent tier.
- **REORDER** — item below its reorder point but not critical.
- **REVIEW** — status of an item with too little history to classify automatically; surfaced for human judgment with no auto-suggested quantity.
- **Health %** — ratio of on-hand stock to the reorder point, expressed as a percentage.
- **Actual stock sync** — the daily upload of the clinic's Stock Balance report that owns on-hand quantities. Procura never edits stock directly; it layers in-flight and history knowledge on top.
- **In-flight** — an order placed but not yet arrived: open POs, active direct orders, unclosed RFQs. Tracked per item so nothing is ordered twice.
- **Direct order** — purchase made without an RFQ round; recorded against the item it was planned from.
- **Name alias** — a remembered mapping between a supplier's line-item name and the internal catalogue item. Recorded once by human confirmation; reused for automatic matching thereafter.
- **Initial stock target** — a manually chosen stock level for a newly acquired item with no usage history; stands in for velocity-derived quantities until real usage accumulates.
- **Linkage** — the association between a plan recommendation and the line item that fulfils it (via stock_id). Broken linkage means ordered items keep appearing as needing order.
