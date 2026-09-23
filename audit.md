# Procura bug audit — 2026-09-23

Scope: Graft assisted source review on 2026-09-23. The findings below preserve the original evidence and line numbers; they describe the code before the fixes.

## Fix status — 2026-09-23

| Finding | Status | Merged PR |
| --- | --- | --- |
| 1. Production demo login | Fixed; production route returns 405 | [#20](https://github.com/H4fizWasabie/procura/pull/20) |
| 2. Stale account sessions | Fixed; current user and auth version checked | [#22](https://github.com/H4fizWasabie/procura/pull/22) |
| 3. Partial PO save | Fixed; header and lines committed together | [#23](https://github.com/H4fizWasabie/procura/pull/23) |
| 4. Destructive movement reimport | Fixed; usable rows required and replacement is atomic | [#25](https://github.com/H4fizWasabie/procura/pull/25) |
| 5. PO raw line totals | Fixed; calculated totals stored in both representations | [#23](https://github.com/H4fizWasabie/procura/pull/23) |
| 6. Duplicate-name PO linking | Fixed; only selected line updated in one transaction | [#27](https://github.com/H4fizWasabie/procura/pull/27) |
| 7. False workflow success | Fixed; missing/wrong-status and SQL failures reported | [#28](https://github.com/H4fizWasabie/procura/pull/28) |
| 8. High Movers RM0 values | Fixed; value calculated from quantity and current cost | [#30](https://github.com/H4fizWasabie/procura/pull/30) |
| 9. Empty import archive | Fixed; uploaded workbook bytes archived | [#32](https://github.com/H4fizWasabie/procura/pull/32) |
| 10. Frozen chart versus Top 20 | Clarified; contributor table explicitly says it uses current costs. Historical item-level reconciliation remains unavailable. | [#33](https://github.com/H4fizWasabie/procura/pull/33) |
| 11. Wrong SKU purchase history | Fixed; exact SKU preferred, name fallback restricted to unlinked lines | [#35](https://github.com/H4fizWasabie/procura/pull/35) |

Merged master `b07ba93` is deployed to production and the isolated demo. Both installed binaries match SHA-256 `862e68e72cea9c987fbb6a8227bbecf2b37eec89d08e88d545b76387dbec7e38`. Both services were active; production demo login returned 405, isolated demo login and a protected page returned 200, and both SQLite databases passed `PRAGMA quick_check`. Builds passed for the PRs. Automated test suites were not run during these fixes.

## P0 — immediate access risk

1. **Production accepts credential-free demo login.** `POST /api/login/demo` is registered regardless of `PROCURA_DEMO` (`main.go:127-136`), and `DemoLogin` issues a `VIEWER` token without a user record (`internal/auth/auth.go:88-90`). On the production service, the route returned HTTP 200 and its cookie accessed protected `GET /api/session` with HTTP 200. A viewer cannot write, but can read protected procurement data. Gate this route to demo mode and keep production login separate.

## P1 — data or authorization integrity

2. **Deleted or demoted users retain active sessions.** Middleware trusts the role and identity inside a signed token without checking the current `users` row (`internal/auth/auth.go:144-179`). Cookie requests refresh that same claim set for another 15 minutes (`internal/auth/auth.go:113-119`). After `UpdateUser`, `ResetUserPIN`, or `DeleteUser` (`internal/auth/auth.go:293-315`), an already signed-in user can keep the prior access by staying active. Revalidate or revoke sessions when these account changes occur.

3. **A PO save can leave its header and lines inconsistent while returning success.** `Save` writes the PO header, then deletes and reinserts line rows without a transaction; it ignores errors from the delete and each insert (`internal/po/po.go:203-225`). A failed insert can leave a new PO with no lines or an edited PO with only some lines. Wrap the header and line replacement in one transaction and return every write error.

4. **A monthly movement reimport can erase the month.** `ImportMovements` deletes all rows for the selected year/month before inserting replacements, without a transaction and without checking either SQL error (`internal/import/import.go:477-494`). A malformed sheet with a header and one short/blank row returns success with zero imported rows after deleting the existing month. Validate usable rows before replacement, then replace atomically.

## P2 — incorrect results or misleading success

5. **PO raw JSON can disagree with the saved line totals.** The total calculation updates a copy of each item (`for _, it := range p.Items`), then marshals the unchanged `p.Items` into `raw_po_json` (`internal/po/po.go:196-205`). Relational line totals are calculated separately at insert time (`internal/po/po.go:215-222`). If the client omits or sends a stale item `total`, the JSON and rows disagree even on a successful save. Assign calculated totals back to `p.Items[i]` before both representations are written.

6. **Linking one PO line can link other lines with the same name to the wrong SKU.** `LinkLine` selects a specific relational line ID (`internal/po/audit.go:54-72`), but `updateRawJSON` matches raw entries by item name and updates every match that has an empty ID field (`internal/po/audit.go:76-111`). A PO with two identical item names can end up with both raw entries linked to the first selected SKU. Match the corresponding line position or another stable identifier, and commit both representations together.

7. **Workflow actions report success when they changed nothing.** The approve/payment handlers discard service errors and always return `success:true` (`main.go:940-956`). The service updates only POs in the expected prior status and does not check affected row count (`internal/workflow/workflow.go:8-21`). A missing PO or wrong current status therefore gets a success response. Return a conflict/not-found result when no row changes and propagate DB errors.

8. **The High Movers table always shows RM0 for its Value column.** Analytics builds `MoverItem` with `Name` and `Qty` but never assigns `Val` (`internal/analytics/analytics.go:303`); the page renders `i.val` as currency (`templates/analytics.html:133`). Populate the calculated value or remove the Value column.

9. **Full workbook imports record an empty archive file.** `Import` creates `copiedPath` and closes it without writing the uploaded workbook (`internal/import/import.go:39-48`), then stores that path in `import_runs.copied_file` (`internal/import/import.go:165-172`). The recorded copy cannot be used to inspect or restore an import. Save the actual upload or stop claiming a retained copy.

10. **Frozen in-house chart values cannot reconcile to Top 20 contributors.** The monthly chart applies legacy/frozen overrides (`internal/analytics/analytics.go:261-281`), while Top 20 always sums current movement rows at current item costs (`internal/analytics/analytics.go:323-335`). The production July/August 2026 chart snapshots already differ from those recalculations. Either preserve an item-level snapshot or label the contributor table as recalculated so it is not read as a breakdown of the frozen chart.

11. **Item history can show another SKU's last purchase.** Its query accepts either a matching item name or matching stock ID, then takes the newest row (`internal/report/report.go:94-107`). If two SKUs share a name, a newer purchase of the other SKU can win even when the requested stock ID has its own history. Prefer an exact stock ID match and use name only when the line has no usable ID.

## Review notes

- The `VIEWER` write concern was checked and excluded: shared middleware blocks non-GET requests for viewer tokens except the specified self-service/read endpoints (`internal/auth/auth.go:170-179`).
- The P0 production probe requested only a demo token and the protected session endpoint; it did not retrieve procurement records.
- The existing local `CHANGELOG.md` edit and `.codegraph/codegraph.db` modification predate this audit and were left untouched.
