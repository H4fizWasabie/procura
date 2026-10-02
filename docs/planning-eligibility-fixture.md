# #55 synthetic fixture comparison

The comparison uses the 15 invented items in `eligibilityFixture` in
`eligibility_views_test.go`, on a temporary database built by `core.Open`.
No production database or report was used. Baseline: master `0868cdc` (after #56).
The same fixture was run against that baseline and the #55 view changes, without
ROP recalculation between runs. Each item's stored ROP is 10 and cost is 1.
Stock is 2 except AT_ROP (10) and ON_DEMAND / ZERO_EXCLUDED (0).
There are no movements, POs, RFQs, or direct orders in this comparison.

Run the asserted after-state with:

```sh
go test . -run TestEligibilityViewComparison -v
```

| View or metric | Before | After |
| --- | ---: | ---: |
| Planning | 6 | 2 |
| Dashboard alerts / critical count | 9 | 2 |
| Restock report | 12 | 2 |
| Inventory Low stock | 15 | 2 |
| Analytics critical (displayed, capped at 10) | 10 | 2 |
| Analytics restock cost | 116 | 16 |
| Inventory Active | 12 | 13 |
| All inventory / Dashboard total items | 15 | 15 |
| Order dropdown | 15 | 15 |
| Validation MISSING_MOVEMENT | 13 | 15 |
| Validation ZERO_STOCK_WITH_ROP | 1 | 0 |
| Inventory asset valuation | 34 | 34 |

All routine views retain ROUTINE and EMPTY_BEHAVIOUR. Both remain REVIEW in
Planning (no usage history). No retained item changes Planning status.

| View | Items leaving | Items entering |
| --- | --- | --- |
| Planning | DO_NOT_REORDER, NOT_AVAILABLE, ON_DEMAND, UNCLASSIFIED (all previously REVIEW) | None |
| Dashboard alerts | AT_ROP, DO_NOT_REORDER, NOT_AVAILABLE, ON_DEMAND, SURGICAL_CATEGORY, SURGICAL_TYPE, UNCLASSIFIED | None |
| Restock report | ASSET, DO_NOT_REORDER, LEGACY_EXCLUDE_BEHAVIOUR, NOT_AVAILABLE, ON_DEMAND, SERVICE, SURGICAL_CATEGORY, SURGICAL_TYPE, UNCLASSIFIED, UNKNOWN_BEHAVIOUR | None |
| Inventory Low stock | ASSET, AT_ROP, DO_NOT_REORDER, EXCLUDED, LEGACY_EXCLUDE_BEHAVIOUR, NOT_AVAILABLE, ON_DEMAND, SERVICE, SURGICAL_CATEGORY, SURGICAL_TYPE, UNCLASSIFIED, UNKNOWN_BEHAVIOUR, ZERO_EXCLUDED | None |
| Analytics critical (displayed) | ASSET, EXCLUDED, NOT_AVAILABLE, ON_DEMAND, SERVICE, SURGICAL_CATEGORY, SURGICAL_TYPE, UNCLASSIFIED, ZERO_EXCLUDED | EMPTY_BEHAVIOUR |
| Inventory Active | None | LEGACY_EXCLUDE_BEHAVIOUR |
| Validation MISSING_MOVEMENT | None | EXCLUDED, ZERO_EXCLUDED |
| Validation ZERO_STOCK_WITH_ROP | ON_DEMAND | None |
| All inventory / Order dropdown | None | None |

EMPTY_BEHAVIOUR enters the displayed Analytics list because filtering removes
items ahead of the ten-row cap; it was already low-stock in the baseline.
Active now checks only the exclusion flag, so a legacy Exclude behaviour with
the flag off remains browsable. Data-quality validation deliberately includes
excluded items; ZERO_STOCK_WITH_ROP is a routine reorder signal and uses RoutineEligible.

Separate regression tests cover all five loose exclusion representations,
availability spellings and unknown/blank statuses, policy/behaviour/surgical
rules, exact ROP equality, 9.999 stock versus ROP 10, pagination and export,
unfiltered dropdown flags, PO/RFQ create and added-line guards, explicit
acknowledgement/audit rollback, historical edits, and direct-order warnings.
The final commit separately tests stockability-only ROP recalculation, including
seasonal control toggles and the existing weighted-velocity/spike-cap checks.
