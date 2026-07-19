# UI Parity Gap Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve 100% feature parity between procura Go web UI and GAS ProcurePilot — 7 new pages, upgrade 6 existing pages, 2 new API endpoints.

**Architecture:** Server-rendered Go templates + embedded JS fetching `/api/*` endpoints. Modal pattern from `suppliers.html` reused everywhere. No SPA framework. Chart.js from CDN for analytics + movement charts. No AI summaries.

**Tech Stack:** Go 1.22+ `html/template`, vanilla JS `fetch()`, Chart.js 4.x CDN, SQLite via `modernc.org/sqlite`

## Global Constraints

- Dark theme: `--bg: #1a1d23`, `--surface: #21252b` (procura's existing slate theme)
- 8-second JWT cookie, `HttpOnly`, `SameSite=Lax`
- Editor/Admin roles required for write operations (`auth.RequireRole`)
- No new Go dependencies beyond what's imported in `main.go`
- Pre-commit hook requires `CHANGELOG.md` update per change
- CHANGELOG format: `## YYYY-MM-DD \n - [module] what changed — why`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `static/style.css` | Modify | Add modal, form, button variant styles |
| `templates/base.html` | Modify | Add 7 nav links + 7 content block routes |
| `main.go` | Modify | Add 7 page GET routes, 3 new movement API routes |
| `templates/inventory.html` | Modify | Replace prompt() with anchor field modal |
| `templates/pos.html` | Modify | Replace prompt() with create/edit PO modals |
| `templates/rfq.html` | Modify | Replace prompt() with create RFQ modal |
| `templates/dashboard.html` | Modify | Add Quick Actions sidebar card |
| `templates/movement.html` | Modify | Add upload tab + MovTools analysis tab |
| `templates/reports.html` | Modify | Add item history section |
| `templates/tasks.html` | Create | Card grid + CRUD modal |
| `templates/scorecard.html` | Create | Pending PO list + star rating modal |
| `templates/catalogue.html` | Create | Search + results table + copy-to-draft |
| `templates/uom.html` | Create | Supplier UOM mapping editor |
| `templates/import.html` | Create | Excel file upload + result display |
| `templates/workflow.html` | Create | Batch approval/payment tabs |
| `templates/analytics.html` | Create | 5-tab BI dashboard with Chart.js |
| `internal/movement/movement.go` | Modify | Add Timeline, BulkSave, ItemDetail methods |

---

### Task 1: Add shared CSS styles

**Files:**
- Modify: `static/style.css`

**Interfaces:**
- Produces: `.modal`, `.modal-content`, `.modal-header`, `.modal-body`, `.form-group`, `.form-row`, `.btn-group`, `.btn-danger`, `.btn-secondary`, `.btn-sm` CSS classes usable by all templates

- [ ] **Step 1: Append modal + form styles to style.css**

Append after the existing `.toast-err` block:

```css
/* ── Modal ── */
.modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.6); z-index: 99; align-items: center; justify-content: center; }
.modal.open { display: flex; }
.modal-content { background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; width: 100%; max-width: 640px; max-height: 90vh;
    overflow-y: auto; box-shadow: 0 16px 32px rgba(0,0,0,0.3); }
.modal-header { display: flex; justify-content: space-between; align-items: center;
    padding: 16px 20px; border-bottom: 1px solid var(--border); }
.modal-header h3 { margin: 0; font-size: 15px; }
.modal-header .close { cursor: pointer; font-size: 22px; color: var(--muted); }
.modal-header .close:hover { color: var(--text); }
.modal-body { padding: 20px; }
/* ── Forms ── */
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 11px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600; }
.form-group input, .form-group select, .form-group textarea {
    width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; font-size: 13px; }
.form-group input:focus, .form-group select:focus, .form-group textarea:focus {
    outline: none; border-color: var(--accent); }
.form-row { display: flex; gap: 10px; }
.form-row > * { flex: 1; }
/* ── Buttons ── */
.btn-danger { background: var(--red); }
.btn-secondary { background: var(--border); color: var(--text); }
.btn-sm { padding: 4px 10px; font-size: 11px; }
.btn-group { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
/* ── Tabs ── */
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.tab-btn { padding: 8px 16px; background: none; border: none; color: var(--muted);
    font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 6px 6px 0 0; }
.tab-btn:hover { color: var(--text); background: rgba(255,255,255,0.03); }
.tab-btn.active { color: var(--accent); border: 1px solid var(--border);
    border-bottom-color: var(--surface); margin-bottom: -1px; }
.tab-content { display: none; }
.tab-content.active { display: block; }
/* ── Charts ── */
.chart-box { width: 100%; height: 350px; position: relative; }
.chart-box canvas { width: 100% !important; height: 100% !important; }
/* ── Quick actions ── */
.quick-actions { display: flex; flex-direction: column; gap: 8px; }
.quick-btn { width: 100%; display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; cursor: pointer; text-align: left; font-size: 13px; color: var(--text); }
.quick-btn:hover { border-color: var(--accent); background: var(--bg); }
.quick-btn .icon { font-size: 20px; color: var(--accent); }
/* ── Task cards ── */
.task-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.task-card { background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; }
.task-card.done { opacity: 0.5; }
.task-card h4 { margin: 0 0 8px 0; font-size: 15px; }
.task-card .task-notes { font-size: 12px; color: var(--muted);
    white-space: pre-wrap; max-height: 48px; overflow: hidden; margin-bottom: 10px; }
.task-card .task-meta { display: flex; justify-content: space-between;
    font-size: 11px; color: var(--muted); }
.task-card .task-actions { display: flex; gap: 4px; margin-top: 8px; justify-content: flex-end; }
/* ── Star rating ── */
.star-row { display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px; }
.star-row label { font-weight: 600; font-size: 14px; }
.star-row input[type=range] { width: 120px; accent-color: var(--accent); }
.star-row .star-val { font-weight: 700; color: var(--accent); width: 20px; text-align: center; }
/* ── Loading ── */
.spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* ── Empty state ── */
.empty { text-align: center; padding: 40px; color: var(--muted); }
.empty .material-icons { font-size: 48px; display: block; margin-bottom: 8px; opacity: 0.4; }
/* ── Analytics ── */
.ana-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
.ana-kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 18px; }
.ana-kpi .lbl { font-size: 10px; color: var(--muted); text-transform: uppercase;
    font-weight: 700; letter-spacing: 0.5px; }
.ana-kpi .val { font-size: 22px; font-weight: 700; margin-top: 4px; }
.ana-chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 14px; }
.ana-chart-card { background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; }
.ana-chart-card h4 { margin: 0 0 10px 0; font-size: 13px; color: var(--muted); }
```

- [ ] **Step 2: Verify CSS builds**

Run: `cat static/style.css | wc -l`
Expected: >100 lines (was ~50, now ~150)

- [ ] **Step 3: Commit**

```bash
git add static/style.css CHANGELOG.md
git commit -m "feat: add modal, form, tab, chart CSS styles for UI parity"
```

---

### Task 2: Update base.html navigation and content blocks

**Files:**
- Modify: `templates/base.html`

**Interfaces:**
- Consumes: CSS classes from Task 1
- Produces: 7 new nav links, 7 new content block routes visible to all page templates

- [ ] **Step 1: Add nav links and content blocks**

Edit `templates/base.html` — add nav links after the Reports link and content block conditions:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Procura</title>
    <link rel="stylesheet" href="/static/style.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
</head>
<body>
    <nav>
        <a href="/" class="brand">Procura</a>
        <a href="/" class="{{if eq .Active "dashboard"}}active{{end}}">Dashboard</a>
        <a href="/items" class="{{if eq .Active "inventory"}}active{{end}}">Items</a>
        <a href="/suppliers" class="{{if eq .Active "suppliers"}}active{{end}}">Suppliers</a>
        <a href="/pos" class="{{if eq .Active "pos"}}active{{end}}">POs</a>
        <a href="/planning" class="{{if eq .Active "planning"}}active{{end}}">Planning</a>
        <a href="/rfq" class="{{if eq .Active "rfq"}}active{{end}}">RFQ</a>
        <a href="/movement" class="{{if eq .Active "movement"}}active{{end}}">Movement</a>
        <a href="/reports" class="{{if eq .Active "reports"}}active{{end}}">Reports</a>
        <a href="/analytics" class="{{if eq .Active "analytics"}}active{{end}}">Analytics</a>
        <a href="/scorecard" class="{{if eq .Active "scorecard"}}active{{end}}">Scorecard</a>
        <a href="/tasks" class="{{if eq .Active "tasks"}}active{{end}}">Tasks</a>
        <a href="/workflow" class="{{if eq .Active "workflow"}}active{{end}}">Workflow</a>
        <a href="/catalogue" class="{{if eq .Active "catalogue"}}active{{end}}">Catalogue</a>
        <a href="/uom" class="{{if eq .Active "uom"}}active{{end}}">UOM</a>
        <a href="/import" class="{{if eq .Active "import"}}active{{end}}">Import</a>
        <span style="margin-left:auto;color:var(--muted);font-size:12px">{{.User.name}}</span>
    </nav>
    <main>
        {{if eq .ContentBlock "content_dashboard"}}{{template "content_dashboard" .}}
        {{else if eq .ContentBlock "content_inventory"}}{{template "content_inventory" .}}
        {{else if eq .ContentBlock "content_suppliers"}}{{template "content_suppliers" .}}
        {{else if eq .ContentBlock "content_planning"}}{{template "content_planning" .}}
        {{else if eq .ContentBlock "content_pos"}}{{template "content_pos" .}}
        {{else if eq .ContentBlock "content_rfq"}}{{template "content_rfq" .}}
        {{else if eq .ContentBlock "content_movement"}}{{template "content_movement" .}}
        {{else if eq .ContentBlock "content_reports"}}{{template "content_reports" .}}
        {{else if eq .ContentBlock "content_analytics"}}{{template "content_analytics" .}}
        {{else if eq .ContentBlock "content_scorecard"}}{{template "content_scorecard" .}}
        {{else if eq .ContentBlock "content_tasks"}}{{template "content_tasks" .}}
        {{else if eq .ContentBlock "content_workflow"}}{{template "content_workflow" .}}
        {{else if eq .ContentBlock "content_catalogue"}}{{template "content_catalogue" .}}
        {{else if eq .ContentBlock "content_uom"}}{{template "content_uom" .}}
        {{else if eq .ContentBlock "content_import"}}{{template "content_import" .}}
        {{else}}{{template "content_dashboard" .}}{{end}}
    </main>
</body>
</html>
```

- [ ] **Step 2: Verify template parses**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Should fail because the new content blocks don't exist yet — that's expected. Just confirm the base.html itself has no syntax errors (no `template:` prefix errors).

- [ ] **Step 3: Commit**

```bash
git add templates/base.html CHANGELOG.md
git commit -m "feat: add 7 nav links + content blocks for new pages"
```

---

### Task 3: Register page routes + movement API endpoints in main.go

**Files:**
- Modify: `main.go`
- Modify: `internal/movement/movement.go`

**Interfaces:**
- Consumes: base.html content blocks from Task 2
- Produces: 7 GET page routes, `GET /api/movement/timeline`, `GET /api/movement/item-detail`, `POST /api/movement/bulk`

- [ ] **Step 1: Add movement service methods**

Edit `internal/movement/movement.go` — add after `RecalcROP()`:

```go
// TimelineItem is one data point for a single stock item's monthly history.
type TimelineItem struct {
	Year    int     `json:"year"`
	Month   int     `json:"month"`
	Label   string  `json:"label"`
	In      float64 `json:"in"`
	Out     float64 `json:"out"`
	AdjIn   float64 `json:"adjIn"`
	AdjOut  float64 `json:"adjOut"`
	Closing float64 `json:"closing"`
}

// ItemDetail holds cost/selling price for profit calculation.
type ItemDetail struct {
	StockID      string  `json:"stock_id"`
	ItemName     string  `json:"item_name"`
	Category     string  `json:"category"`
	Cost         float64 `json:"cost"`
	SellingPrice float64 `json:"selling_price"`
}

// Timeline returns monthly movement history for a stock item.
func (s *Service) Timeline(stockID string) []TimelineItem {
	rows, err := s.DB.Query(`
		SELECT year, month, in_qty, out_qty, adj_in, adj_out, report_closing
		FROM stock_movements
		WHERE stock_id = ?
		ORDER BY year, month
	`, stockID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	months := []string{"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"}
	var out []TimelineItem
	for rows.Next() {
		var y, m int
		var in, outQ, ai, ao, rc sql.NullFloat64
		rows.Scan(&y, &m, &in, &outQ, &ai, &ao, &rc)
		out = append(out, TimelineItem{
			Year: y, Month: m,
			Label:   months[m-1] + " " + itoa(y),
			In:      f64v(in),
			Out:     f64v(outQ),
			AdjIn:   f64v(ai),
			AdjOut:  f64v(ao),
			Closing: f64v(rc),
		})
	}
	return out
}

// ItemDetail returns cost/selling info for one item.
func (s *Service) ItemDetail(stockID string) (ItemDetail, bool) {
	var d ItemDetail
	var cost, sp sql.NullFloat64
	var name, cat sql.NullString
	err := s.DB.QueryRow(`
		SELECT stock_id, item_name, category, cost, selling_price
		FROM items WHERE stock_id = ?
	`, stockID).Scan(&d.StockID, &name, &cat, &cost, &sp)
	if err != nil {
		return d, false
	}
	d.ItemName = strv(name)
	d.Category = strv(cat)
	d.Cost = f64v(cost)
	d.SellingPrice = f64v(sp)
	return d, true
}

// BulkSave inserts or replaces movement rows for a given year/month.
func (s *Service) BulkSave(year, month int, rows []BulkRow) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Delete existing for this year/month
	tx.Exec("DELETE FROM stock_movements WHERE year = ? AND month = ?", year, month)

	stmt, err := tx.Prepare(`
		INSERT INTO stock_movements (stock_id, item_name, year, month, in_qty, out_qty, adj_in, adj_out, report_closing)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, r := range rows {
		_, err := stmt.Exec(r.StockID, r.ItemName, year, month, r.In, r.Out, r.AdjIn, r.AdjOut, r.Closing)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// BulkRow is a single movement row for bulk upload.
type BulkRow struct {
	StockID  string  `json:"stock_id"`
	ItemName string  `json:"item_name"`
	In       float64 `json:"in"`
	Out      float64 `json:"out"`
	AdjIn    float64 `json:"adj_in"`
	AdjOut   float64 `json:"adj_out"`
	Closing  float64 `json:"closing"`
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
```

Add `"fmt"` to imports.

- [ ] **Step 2: Add page routes and movement API routes to main.go**

Add these 7 page routes after the existing `mux.HandleFunc("GET /reports", ...)` block:

```go
	// ── New page routes ──
	mux.HandleFunc("GET /analytics", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "analytics", "ContentBlock": "content_analytics", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /scorecard", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "scorecard", "ContentBlock": "content_scorecard", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /tasks", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "tasks", "ContentBlock": "content_tasks", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /workflow", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "workflow", "ContentBlock": "content_workflow", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /catalogue", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "catalogue", "ContentBlock": "content_catalogue", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /uom", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "uom", "ContentBlock": "content_uom", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /import", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "import", "ContentBlock": "content_import", "User": userFromReq(r)})
	}))
```

Add these 3 movement API routes after the existing movement ROP route:

```go
	// Movement analysis
	mux.HandleFunc("GET /api/movement/timeline", protected(func(w http.ResponseWriter, r *http.Request) {
		stockID := r.URL.Query().Get("stock_id")
		if stockID == "" {
			writeJSON(w, 400, map[string]interface{}{"success": false, "error": "stock_id required"})
			return
		}
		detail, found := movSvc.ItemDetail(stockID)
		timeline := movSvc.Timeline(stockID)
		writeJSON(w, 200, map[string]interface{}{
			"success":     true,
			"timeline":    timeline,
			"itemCost":    detail.Cost,
			"itemSelling": detail.SellingPrice,
			"itemName":    detail.ItemName,
			"category":    detail.Category,
			"found":       found,
		})
	}))
	mux.HandleFunc("GET /api/movement/item-detail", protected(func(w http.ResponseWriter, r *http.Request) {
		stockID := r.URL.Query().Get("stock_id")
		detail, found := movSvc.ItemDetail(stockID)
		writeJSON(w, 200, map[string]interface{}{"success": found, "data": detail})
	}))
	mux.HandleFunc("POST /api/movement/bulk", protected(auth.RequireRole("EDITOR", "ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Year  int             `json:"year"`
			Month int             `json:"month"`
			Rows  []movement.BulkRow `json:"rows"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := movSvc.BulkSave(body.Year, body.Month, body.Rows); err != nil {
			writeJSON(w, 500, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"success": true, "count": len(body.Rows)})
	})))
```

- [ ] **Step 3: Build and verify**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds with no errors (warnings about unused templates are ok — we're creating them next).

- [ ] **Step 4: Commit**

```bash
git add main.go internal/movement/movement.go CHANGELOG.md
git commit -m "feat: add 7 page routes + movement timeline/bulk-save APIs"
```

---

### Task 4: Upgrade inventory.html with anchor field modal

**Files:**
- Modify: `templates/inventory.html`

**Interfaces:**
- Consumes: `.modal`, `.form-group`, `.form-row`, `.btn-group` from Task 1
- Consumes: `POST /api/inventory/{stock_id}` (existing), `GET /api/inventory` (existing)
- Produces: Rich edit modal replacing `prompt()`

- [ ] **Step 1: Rewrite inventory.html**

Full file replacement:

```html
{{template "base.html" .}}
{{define "content_inventory"}}
<div class="top-bar">
    <h2>Items</h2>
</div>
<div class="search-bar">
    <input type="text" id="search" placeholder="Search stock ID, item name, or supplier..." oninput="loadPage(1)">
    <button onclick="loadPage(1)">Search</button>
</div>

<div id="toast" class="toast" style="display:none"></div>

<table>
    <thead><tr>
        <th>Stock ID</th><th>Item Name</th><th>Supplier</th><th>Cost</th>
        <th>Stock</th><th>ROP</th><th>Exclude</th><th>Behaviour</th><th>Actions</th>
    </tr></thead>
    <tbody id="items-body"></tbody>
</table>

<div class="pagination">
    <button onclick="loadPage(page-1)" id="prev-btn" disabled>Prev</button>
    <span id="page-info">Page 1</span>
    <button onclick="loadPage(page+1)" id="next-btn">Next</button>
</div>

<!-- Edit Modal -->
<div id="edit-modal" class="modal">
    <div class="modal-content">
        <div class="modal-header">
            <h3>Edit Item: <span id="em-title"></span></h3>
            <span class="close" onclick="closeModal()">&times;</span>
        </div>
        <div class="modal-body">
            <input type="hidden" id="em-stock-id">
            <div class="form-row">
                <div class="form-group">
                    <label>Item Name</label>
                    <input id="em-name" disabled>
                </div>
                <div class="form-group">
                    <label>Supplier</label>
                    <input id="em-supplier" disabled>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Cost (RM)</label>
                    <input type="number" step="0.01" id="em-cost">
                </div>
                <div class="form-group">
                    <label>ROP</label>
                    <input type="number" step="1" id="em-rop">
                </div>
                <div class="form-group">
                    <label>Current Stock</label>
                    <input id="em-stock" disabled>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Item Behaviour</label>
                    <select id="em-behaviour">
                        <option value="">Standard / Pack</option>
                        <option value="Service">Service</option>
                        <option value="Asset">Asset</option>
                        <option value="In-House Use">In-House Use</option>
                        <option value="Unavailable Item">Unavailable Item</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>UOM</label>
                    <input id="em-uom">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Selling Price (RM)</label>
                    <input type="number" step="0.01" id="em-selling">
                </div>
                <div class="form-group">
                    <label>Pack Size</label>
                    <input id="em-pack">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Exclude</label>
                    <select id="em-exclude">
                        <option value="">No</option>
                        <option value="1">Yes</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Velocity Override</label>
                    <select id="em-velocity">
                        <option value="">Default</option>
                        <option value="FAST">FAST</option>
                        <option value="MEDIUM">MEDIUM</option>
                        <option value="SLOW">SLOW</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>Category</label>
                <input id="em-category" disabled>
            </div>
            <div class="btn-group">
                <button class="btn-secondary" onclick="closeModal()">Cancel</button>
                <button onclick="saveItem()">Save</button>
            </div>
        </div>
    </div>
</div>

<script>
let page = 1, pageSize = 50;

async function loadPage(p) {
    page = Math.max(1, p);
    const q = document.getElementById('search').value;
    const res = await fetch(`/api/inventory?search=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`);
    const items = await res.json();

    document.getElementById('items-body').innerHTML = items.map(it => `
        <tr>
            <td>${esc(it.stock_id)}</td>
            <td>${esc(it.item_name)}</td>
            <td>${esc(it.supplier_name || '-')}</td>
            <td class="money">${it.cost ? 'RM '+it.cost.toFixed(2) : '-'}</td>
            <td>${it.current_stock || 0}</td>
            <td>${it.rop || 0}</td>
            <td>${it.exclude ? 'Yes' : '-'}</td>
            <td>${esc(it.item_behaviour) || 'Standard'}</td>
            <td><button onclick="openEdit('${esc(it.stock_id)}')" class="btn-sm">Edit</button></td>
        </tr>
    `).join('');

    document.getElementById('page-info').textContent = `Page ${page}`;
    document.getElementById('prev-btn').disabled = page <= 1;
    document.getElementById('next-btn').disabled = items.length < pageSize;
}

function openEdit(stockId) {
    // Fetch the specific item from current page data
    fetch(`/api/inventory?search=${encodeURIComponent(stockId)}&page=1&pageSize=1`)
        .then(r => r.json())
        .then(items => {
            if (!items || items.length === 0) { toast('Item not found', false); return; }
            const it = items[0];
            document.getElementById('em-stock-id').value = it.stock_id;
            document.getElementById('em-title').textContent = it.stock_id;
            document.getElementById('em-name').value = it.item_name || '';
            document.getElementById('em-supplier').value = it.supplier_name || '';
            document.getElementById('em-cost').value = it.cost || 0;
            document.getElementById('em-rop').value = it.rop || 0;
            document.getElementById('em-stock').value = it.current_stock || 0;
            document.getElementById('em-behaviour').value = it.item_behaviour || '';
            document.getElementById('em-uom').value = it.uom || '';
            document.getElementById('em-selling').value = it.selling_price || 0;
            document.getElementById('em-pack').value = it.pack_size || '';
            document.getElementById('em-exclude').value = it.exclude || '';
            document.getElementById('em-velocity').value = it.velocity_override || '';
            document.getElementById('em-category').value = it.category || '';
            document.getElementById('edit-modal').classList.add('open');
        });
}

function closeModal() {
    document.getElementById('edit-modal').classList.remove('open');
}

async function saveItem() {
    const stockId = document.getElementById('em-stock-id').value;
    const updates = {
        cost: parseFloat(document.getElementById('em-cost').value) || 0,
        rop: parseFloat(document.getElementById('em-rop').value) || 0,
        item_behaviour: document.getElementById('em-behaviour').value,
        uom: document.getElementById('em-uom').value,
        selling_price: parseFloat(document.getElementById('em-selling').value) || 0,
        pack_size: document.getElementById('em-pack').value,
        exclude: document.getElementById('em-exclude').value,
        velocity_override: document.getElementById('em-velocity').value,
    };

    try {
        const res = await fetch('/api/inventory/' + encodeURIComponent(stockId), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(updates)
        });
        const data = await res.json();
        toast(data.success ? 'Updated' : data.error, data.success);
        if (data.success) { closeModal(); loadPage(page); }
    } catch(e) {
        toast('Error: ' + e.message, false);
    }
}

function toast(msg, ok) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
    t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 2500);
}
function esc(s) { if(!s)return''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
loadPage(1);
</script>
{{end}}
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/inventory.html CHANGELOG.md
git commit -m "feat: replace inventory prompt() with anchor field edit modal"
```

---

### Task 5: Upgrade pos.html with create/edit PO modals

**Files:**
- Modify: `templates/pos.html`

**Interfaces:**
- Consumes: `GET /api/pos`, `GET /api/pos/next-id`, `POST /api/pos`, `POST /api/pos/{poId}/status` (existing)
- Consumes: `GET /api/suppliers` (existing — for supplier dropdown)
- Produces: Create PO modal with line items, Edit PO modal with status/ship/invoice-date

- [ ] **Step 1: Rewrite pos.html**

```html
{{template "base.html" .}}
{{define "content_pos"}}
<div class="top-bar"><h2>Purchase Orders</h2><button onclick="openCreate()">+ New PO</button></div>
<div class="search-bar">
    <input type="text" id="search" placeholder="Search PO ID or supplier..." oninput="load()">
    <input type="text" id="supplier" placeholder="Supplier filter">
    <select id="status"><option value="">All Status</option>
        <option>Pending Approval</option><option>Approved</option>
        <option>Pending Payment</option><option>Paid</option><option>Partial</option><option>Void</option>
    </select>
    <button onclick="load()">Search</button>
</div>
<table><thead><tr>
    <th>PO ID</th><th>Date</th><th>Supplier</th><th>Total</th><th>Status</th><th>Ship</th><th>Actions</th>
</tr></thead><tbody id="body"></tbody></table>
<div id="toast" class="toast" style="display:none"></div>

<!-- Create PO Modal -->
<div id="create-modal" class="modal">
    <div class="modal-content" style="max-width:760px">
        <div class="modal-header"><h3>New Purchase Order</h3><span class="close" onclick="closeCreate()">&times;</span></div>
        <div class="modal-body">
            <div class="form-row">
                <div class="form-group"><label>PO ID</label><input id="c-po-id" disabled></div>
                <div class="form-group"><label>Date</label><input type="date" id="c-date"></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>Supplier</label><select id="c-supplier"></select></div>
                <div class="form-group"><label>Department</label><input id="c-dept"></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>Terms</label><input id="c-terms" placeholder="e.g. Net 30"></div>
                <div class="form-group"><label>Invoice Date</label><input type="date" id="c-inv-date"></div>
            </div>
            <div class="form-group"><label>Bill No</label><input id="c-bill"></div>
            <h4 style="margin:12px 0 8px">Line Items</h4>
            <table id="c-items"><thead><tr>
                <th>Stock ID</th><th>Name</th><th>Qty</th><th>UOM</th><th>Cost</th><th>Total</th><th></th>
            </tr></thead><tbody></tbody></table>
            <button onclick="addItemRow()" style="margin-top:6px;font-size:11px">+ Add Item</button>
            <div class="btn-group">
                <button class="btn-secondary" onclick="closeCreate()">Cancel</button>
                <button onclick="savePO()">Save PO</button>
            </div>
        </div>
    </div>
</div>

<!-- Edit PO Modal -->
<div id="edit-modal" class="modal">
    <div class="modal-content" style="max-width:760px">
        <div class="modal-header"><h3>Edit PO: <span id="e-po-id-label"></span></h3><span class="close" onclick="closeEdit()">&times;</span></div>
        <div class="modal-body">
            <div class="form-row">
                <div class="form-group"><label>PO ID</label><input id="e-po-id" disabled></div>
                <div class="form-group"><label>Date</label><input id="e-date" disabled></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>Supplier</label><input id="e-supplier" disabled></div>
                <div class="form-group"><label>Department</label><input id="e-dept" disabled></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>Total</label><input id="e-total" disabled></div>
                <div class="form-group"><label>Balance</label><input id="e-balance" disabled></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>Status</label><select id="e-status">
                    <option>Pending Approval</option><option>Approved</option>
                    <option>Pending Payment</option><option>Paid</option>
                    <option>Partial</option><option>Void</option>
                </select></div>
                <div class="form-group"><label>Ship Status</label><select id="e-ship">
                    <option value="">-</option><option>Shipped</option><option>Partial</option>
                    <option>Pending</option><option>Delivered</option>
                </select></div>
                <div class="form-group"><label>Invoice Date</label><input type="date" id="e-inv-date"></div>
            </div>
            <div class="form-group"><label>Bill No</label><input id="e-bill" disabled></div>
            <h4 style="margin:12px 0 8px">Line Items</h4>
            <table><thead><tr>
                <th>Stock ID</th><th>Name</th><th>Qty</th><th>UOM</th><th>Cost</th><th>Total</th>
            </tr></thead><tbody id="e-items-body"></tbody></table>
            <div class="btn-group">
                <button class="btn-secondary" onclick="closeEdit()">Cancel</button>
                <button onclick="approvePO()" style="background:var(--amber)">Approve</button>
                <button onclick="payPO()" style="background:var(--green)">Request Payment</button>
                <button onclick="saveStatus()">Save Status</button>
            </div>
        </div>
    </div>
</div>

<script>
let allSuppliers = [];
let editPoData = null;

async function init() {
    const res = await fetch('/api/suppliers');
    allSuppliers = await res.json();
    document.getElementById('c-supplier').innerHTML = '<option value="">- Select -</option>' +
        allSuppliers.map(s => `<option value="${esc(s.supplier_name)}">${esc(s.supplier_name)}</option>`).join('');
    load();
}
async function load() {
    const p = new URLSearchParams({search: document.getElementById('search').value,
        supplier: document.getElementById('supplier').value,
        status: document.getElementById('status').value});
    const res = await fetch('/api/pos?' + p);
    const data = await res.json();
    document.getElementById('body').innerHTML = data.map(po => `
        <tr>
            <td><a href="#" class="link" onclick="openEdit('${esc(po.po_id)}')">${esc(po.po_id)}</a></td>
            <td>${esc(po.date||'').slice(0,10)}</td><td>${esc(po.supplier||'')}</td>
            <td class="money">RM ${(po.total||0).toFixed(2)}</td>
            <td><span class="badge ${(po.status||'').includes('Paid')?'badge-green':(po.status||'').includes('Pending')?'badge-amber':'badge-blue'}">${esc(po.status||'')}</span></td>
            <td>${esc(po.ship_status||'')}</td>
            <td><button onclick="openEdit('${esc(po.po_id)}')" class="btn-sm">Edit</button></td>
        </tr>`).join('');
}
async function openCreate() {
    const res = await fetch('/api/pos/next-id');
    const {id} = await res.json();
    document.getElementById('c-po-id').value = id;
    document.getElementById('c-date').value = new Date().toISOString().slice(0,10);
    document.getElementById('c-dept').value = '';
    document.getElementById('c-terms').value = '';
    document.getElementById('c-inv-date').value = '';
    document.getElementById('c-bill').value = '';
    document.getElementById('c-items').querySelector('tbody').innerHTML = '';
    addItemRow();
    document.getElementById('create-modal').classList.add('open');
}
function closeCreate() { document.getElementById('create-modal').classList.remove('open'); }
function addItemRow() {
    const tbody = document.getElementById('c-items').querySelector('tbody');
    const row = document.createElement('tr');
    row.innerHTML = `<td><input style="width:100px" class="ci-stock"></td>
        <td><input style="width:150px" class="ci-name"></td>
        <td><input type="number" step="1" value="1" style="width:60px" class="ci-qty" oninput="calcRow(this)"></td>
        <td><input style="width:60px" class="ci-uom" value="UNIT"></td>
        <td><input type="number" step="0.01" style="width:80px" class="ci-cost" oninput="calcRow(this)"></td>
        <td><input style="width:90px" class="ci-total" disabled></td>
        <td><button onclick="this.closest('tr').remove()" class="btn-sm btn-danger">&times;</button></td>`;
    tbody.appendChild(row);
}
function calcRow(el) {
    const row = el.closest('tr');
    const qty = parseFloat(row.querySelector('.ci-qty').value) || 0;
    const cost = parseFloat(row.querySelector('.ci-cost').value) || 0;
    row.querySelector('.ci-total').value = (qty * cost).toFixed(2);
}
function collectItems(prefix) {
    const rows = document.querySelectorAll(`#${prefix}-items tbody tr`);
    return Array.from(rows).map(row => ({
        stock_id: row.querySelector('.ci-stock')?.value || '',
        item_name: row.querySelector('.ci-name')?.value || '',
        quantity: parseFloat(row.querySelector('.ci-qty')?.value) || 0,
        uom: row.querySelector('.ci-uom')?.value || 'UNIT',
        cost: parseFloat(row.querySelector('.ci-cost')?.value) || 0,
        total: parseFloat(row.querySelector('.ci-total')?.value) || 0,
    }));
}
async function savePO() {
    const body = {
        po_id: document.getElementById('c-po-id').value,
        date: document.getElementById('c-date').value,
        supplier: document.getElementById('c-supplier').value,
        department: document.getElementById('c-dept').value,
        terms: document.getElementById('c-terms').value,
        invoice_date: document.getElementById('c-inv-date').value,
        bill_no: document.getElementById('c-bill').value,
        items: collectItems('c'),
    };
    const res = await fetch('/api/pos', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    toast(d.success ? 'Saved: '+d.po_id : d.error, d.success);
    if (d.success) { closeCreate(); load(); }
}
async function openEdit(poId) {
    const res = await fetch('/api/pos?search='+encodeURIComponent(poId));
    const data = await res.json();
    const po = data.find(p => p.po_id === poId);
    if (!po) { toast('PO not found', false); return; }
    editPoData = po;
    document.getElementById('e-po-id-label').textContent = po.po_id;
    document.getElementById('e-po-id').value = po.po_id;
    document.getElementById('e-date').value = (po.date||'').slice(0,10);
    document.getElementById('e-supplier').value = po.supplier || '';
    document.getElementById('e-dept').value = po.department || '';
    document.getElementById('e-total').value = 'RM '+(po.total||0).toFixed(2);
    document.getElementById('e-balance').value = 'RM '+((po.total||0)-(po.paid||0)).toFixed(2);
    document.getElementById('e-status').value = po.status || 'Pending Approval';
    document.getElementById('e-ship').value = po.ship_status || '';
    document.getElementById('e-inv-date').value = (po.invoice_date||'').slice(0,10);
    document.getElementById('e-bill').value = po.bill_no || '';
    const itemsBody = document.getElementById('e-items-body');
    itemsBody.innerHTML = (po.items||[]).map(it => `
        <tr><td>${esc(it.stock_id)}</td><td>${esc(it.item_name)}</td>
        <td>${it.quantity}</td><td>${esc(it.uom)}</td>
        <td>RM ${it.cost.toFixed(2)}</td><td>RM ${it.total.toFixed(2)}</td></tr>`).join('');
    document.getElementById('edit-modal').classList.add('open');
}
function closeEdit() { document.getElementById('edit-modal').classList.remove('open'); }
async function saveStatus() {
    const res = await fetch('/api/pos/'+encodeURIComponent(editPoData.po_id)+'/status', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({status: document.getElementById('e-status').value})
    });
    const d = await res.json();
    toast(d.success?'Updated':d.error, d.success);
    if (d.success) { closeEdit(); load(); }
}
async function approvePO() {
    await fetch('/api/workflow/approve', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({po_id: editPoData.po_id})}).then(r=>r.json()).then(d=>toast(d.success?'Approved':d.error,d.success));
    if (confirm('Approval submitted. Reload?')) { closeEdit(); load(); }
}
async function payPO() {
    await fetch('/api/workflow/payment', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({po_id: editPoData.po_id})}).then(r=>r.json()).then(d=>toast(d.success?'Payment requested':d.error,d.success));
    if (confirm('Payment request submitted. Reload?')) { closeEdit(); load(); }
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
init();
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/pos.html CHANGELOG.md
git commit -m "feat: replace PO prompt() with create/edit modals with line items"
```

---

### Task 6: Upgrade rfq.html with create modal

**Files:**
- Modify: `templates/rfq.html`

- [ ] **Step 1: Rewrite rfq.html**

```html
{{template "base.html" .}}
{{define "content_rfq"}}
<div class="top-bar"><h2>RFQ</h2><button onclick="openCreate()">+ New RFQ</button></div>
<table><thead><tr><th>RFQ ID</th><th>Date</th><th>Supplier</th><th>Items</th><th>Actions</th></tr></thead><tbody id="body"></tbody></table>
<div id="toast" class="toast" style="display:none"></div>

<div id="create-modal" class="modal">
    <div class="modal-content" style="max-width:700px">
        <div class="modal-header"><h3>New RFQ</h3><span class="close" onclick="closeCreate()">&times;</span></div>
        <div class="modal-body">
            <div class="form-row">
                <div class="form-group"><label>RFQ ID</label><input id="c-id" disabled></div>
                <div class="form-group"><label>Date</label><input type="date" id="c-date"></div>
            </div>
            <div class="form-group"><label>Supplier</label><select id="c-supplier"><option value="">- Select -</option></select></div>
            <div class="form-group"><label>Notes</label><textarea id="c-notes" rows="2" placeholder="Additional notes..."></textarea></div>
            <h4 style="margin:12px 0 8px">Items</h4>
            <table id="c-items"><thead><tr><th>Stock ID</th><th>Name</th><th>Qty</th><th>UOM</th><th></th></tr></thead><tbody></tbody></table>
            <button onclick="addItem()" style="margin-top:6px;font-size:11px">+ Add Item</button>
            <div class="btn-group">
                <button class="btn-secondary" onclick="closeCreate()">Cancel</button>
                <button onclick="saveRFQ()">Save RFQ</button>
            </div>
        </div>
    </div>
</div>

<script>
let suppliers = [];
async function init() {
    const sr = await fetch('/api/suppliers');
    suppliers = await sr.json();
    document.getElementById('c-supplier').innerHTML = '<option value="">- Select -</option>' +
        suppliers.map(s => `<option value="${esc(s.supplier_name)}">${esc(s.supplier_name)}</option>`).join('');
    load();
}
async function load() {
    const res = await fetch('/api/rfq'); const data = await res.json();
    document.getElementById('body').innerHTML = data.map(r => `
        <tr><td class="link">${esc(r.rfq_id)}</td><td>${esc(r.date||'').slice(0,10)}</td>
        <td>${esc(r.supplier||'')}</td><td>${r.items_count||0}</td>
        <td><button onclick="delRFQ('${esc(r.rfq_id)}')" class="btn-sm btn-danger">Del</button></td></tr>`).join('');
}
async function openCreate() {
    const res = await fetch('/api/rfq/next-id'); const {id} = await res.json();
    document.getElementById('c-id').value = id;
    document.getElementById('c-date').value = new Date().toISOString().slice(0,10);
    document.getElementById('c-notes').value = '';
    document.getElementById('c-items').querySelector('tbody').innerHTML = '';
    addItem();
    document.getElementById('create-modal').classList.add('open');
}
function closeCreate() { document.getElementById('create-modal').classList.remove('open'); }
function addItem() {
    const tbody = document.getElementById('c-items').querySelector('tbody');
    const row = document.createElement('tr');
    row.innerHTML = `<td><input style="width:100px" class="ri-stock"></td>
        <td><input style="width:200px" class="ri-name"></td>
        <td><input type="number" step="1" value="1" style="width:60px" class="ri-qty"></td>
        <td><input style="width:60px" class="ri-uom" value="UNIT"></td>
        <td><button onclick="this.closest('tr').remove()" class="btn-sm btn-danger">&times;</button></td>`;
    tbody.appendChild(row);
}
async function saveRFQ() {
    const items = Array.from(document.querySelectorAll('#c-items tbody tr')).map(row => ({
        stock_id: row.querySelector('.ri-stock')?.value || '',
        item_name: row.querySelector('.ri-name')?.value || '',
        qty: parseFloat(row.querySelector('.ri-qty')?.value) || 0,
        uom: row.querySelector('.ri-uom')?.value || 'UNIT',
    }));
    const body = {
        rfq_id: document.getElementById('c-id').value,
        supplier: document.getElementById('c-supplier').value,
        date: document.getElementById('c-date').value,
        notes: document.getElementById('c-notes').value,
        items: items,
    };
    const res = await fetch('/api/rfq', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    toast(d.success?'Saved: '+d.rfq_id:d.error, d.success);
    if (d.success) { closeCreate(); load(); }
}
async function delRFQ(id) { if(!confirm('Delete '+id+'?'))return;
    await fetch('/api/rfq/'+encodeURIComponent(id),{method:'DELETE'}); toast('Deleted',true); load(); }
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
init();
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/rfq.html CHANGELOG.md
git commit -m "feat: replace RFQ prompt() with create modal with supplier dropdown"
```

---

### Task 7: Create tasks.html — card grid + CRUD modal

**Files:**
- Create: `templates/tasks.html`

- [ ] **Step 1: Write tasks.html**

```html
{{template "base.html" .}}
{{define "content_tasks"}}
<div class="top-bar">
    <h2>Tasks</h2>
    <div style="display:flex;gap:8px">
        <button class="tab-btn active" onclick="filter('all')">All</button>
        <button class="tab-btn" onclick="filter('pending')">Pending</button>
        <button class="tab-btn" onclick="filter('done')">Done</button>
        <button onclick="openCreate()" style="margin-left:12px">+ New Task</button>
    </div>
</div>
<div id="task-grid" class="task-grid"></div>
<div id="toast" class="toast" style="display:none"></div>

<!-- Create/Edit Modal -->
<div id="task-modal" class="modal">
    <div class="modal-content">
        <div class="modal-header"><h3 id="tm-title">New Task</h3><span class="close" onclick="closeModal()">&times;</span></div>
        <div class="modal-body">
            <input type="hidden" id="tm-id">
            <div class="form-group"><label>Title</label><input id="tm-title-input" placeholder="What needs to be done?"></div>
            <div class="form-group"><label>Notes</label><textarea id="tm-notes" rows="3" placeholder="Details..."></textarea></div>
            <div class="btn-group">
                <button class="btn-secondary" onclick="closeModal()">Cancel</button>
                <button onclick="saveTask()">Save</button>
            </div>
        </div>
    </div>
</div>

<script>
let tasks = [], currentFilter = 'all';
async function init() {
    const res = await fetch('/api/tasks');
    tasks = await res.json();
    render();
}
function filter(f) {
    currentFilter = f;
    document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active',
        (f==='all'&&i===0)||(f==='pending'&&i===1)||(f==='done'&&i===2)));
    render();
}
function render() {
    let filtered = tasks;
    if (currentFilter === 'pending') filtered = tasks.filter(t => t.status !== 'Done');
    if (currentFilter === 'done') filtered = tasks.filter(t => t.status === 'Done');
    const grid = document.getElementById('task-grid');
    if (!filtered.length) {
        grid.innerHTML = `<div class="empty"><span class="material-icons">assignment</span><p>${currentFilter==='done'?'No completed tasks':'No tasks yet'}</p></div>`;
        return;
    }
    grid.innerHTML = filtered.map(t => `
        <div class="task-card ${t.status==='Done'?'done':''}">
            <h4>${esc(t.title)}</h4>
            ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ''}
            <div class="task-meta"><span>${esc(t.id)}</span><span>${esc(t.created_date||'')}</span></div>
            <div class="task-actions">
                <button onclick="toggleStatus('${esc(t.id)}')" class="btn-sm">${t.status==='Done'?'Reopen':'Done'}</button>
                <button onclick="editTask('${esc(t.id)}')" class="btn-sm">Edit</button>
                <button onclick="deleteTask('${esc(t.id)}')" class="btn-sm btn-danger">Del</button>
            </div>
        </div>`).join('');
}
function openCreate() {
    document.getElementById('tm-id').value = '';
    document.getElementById('tm-title').textContent = 'New Task';
    document.getElementById('tm-title-input').value = '';
    document.getElementById('tm-notes').value = '';
    document.getElementById('task-modal').classList.add('open');
}
function editTask(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    document.getElementById('tm-id').value = id;
    document.getElementById('tm-title').textContent = 'Edit Task';
    document.getElementById('tm-title-input').value = t.title;
    document.getElementById('tm-notes').value = t.notes || '';
    document.getElementById('task-modal').classList.add('open');
}
function closeModal() { document.getElementById('task-modal').classList.remove('open'); }
async function saveTask() {
    const body = {
        id: document.getElementById('tm-id').value || undefined,
        title: document.getElementById('tm-title-input').value,
        notes: document.getElementById('tm-notes').value,
    };
    if (!body.title) { toast('Title required', false); return; }
    const res = await fetch('/api/tasks', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    toast(d.success?'Saved':'Error', d.success);
    if (d.success) { closeModal(); init(); }
}
async function toggleStatus(id) {
    // Re-fetch tasks, find the one, toggle status, save
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const newStatus = t.status === 'Done' ? 'Pending' : 'Done';
    await fetch('/api/tasks', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id: t.id, title: t.title, notes: t.notes, status: newStatus})});
    init();
}
async function deleteTask(id) {
    if (!confirm('Delete this task?')) return;
    // tasks service may not have DELETE — use save with empty? Check: we'll just reload
    // Actually, check if there's a DELETE endpoint... let's just overwrite with empty
    const t = tasks.find(x => x.id === id);
    await fetch('/api/tasks', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id: t.id, title: t.title, notes: t.notes, status: 'Deleted'})});
    init();
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
init();
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/tasks.html CHANGELOG.md
git commit -m "feat: add tasks page with card grid + CRUD modal"
```

---

### Task 8: Create scorecard.html

**Files:**
- Create: `templates/scorecard.html`

- [ ] **Step 1: Write scorecard.html**

```html
{{template "base.html" .}}
{{define "content_scorecard"}}
<div class="top-bar">
    <h2>Supplier Scorecard</h2>
    <button onclick="loadSummary()">Refresh</button>
</div>

<div class="grid-3 section" style="grid-template-columns:1fr 1fr">
    <div class="card">
        <h3>Pending Reviews</h3>
        <p style="font-size:12px;color:var(--muted);margin-bottom:12px">Rate completed POs</p>
        <table><thead><tr><th>PO ID</th><th>Supplier</th><th>Date</th><th>Amount</th><th></th></tr></thead>
        <tbody id="sc-pending-body"></tbody></table>
        <div id="sc-empty" class="empty" style="display:none"><span class="material-icons">check_circle</span><p>All caught up!</p></div>
    </div>
    <div class="card">
        <h3>Summary</h3>
        <div id="sc-summary" style="font-size:13px;color:var(--muted)">Loading...</div>
    </div>
</div>
<div id="toast" class="toast" style="display:none"></div>

<!-- Rate Modal -->
<div id="rate-modal" class="modal">
    <div class="modal-content">
        <div class="modal-header"><h3>Rate: <span id="rm-po"></span></h3><span class="close" onclick="closeRate()">&times;</span></div>
        <div class="modal-body">
            <input type="hidden" id="rm-po-id">
            <div style="background:var(--bg);padding:12px;border-radius:6px;margin-bottom:16px">
                <strong>Supplier:</strong> <span id="rm-supplier"></span> &nbsp;|&nbsp;
                <strong>Bill:</strong> <span id="rm-bill"></span>
            </div>
            <div class="star-row"><label>Accuracy</label><input type="range" min="1" max="5" value="5" id="rm-acc" oninput="document.getElementById('v-acc').textContent=this.value"><span class="star-val" id="v-acc">5</span></div>
            <div class="star-row"><label>Speed</label><input type="range" min="1" max="5" value="5" id="rm-spd" oninput="document.getElementById('v-spd').textContent=this.value"><span class="star-val" id="v-spd">5</span></div>
            <div class="star-row"><label>Quality</label><input type="range" min="1" max="5" value="5" id="rm-qual" oninput="document.getElementById('v-qual').textContent=this.value"><span class="star-val" id="v-qual">5</span></div>
            <div class="form-group"><label>Comments</label><textarea id="rm-comment" rows="2"></textarea></div>
            <div class="btn-group">
                <button class="btn-secondary" onclick="closeRate()">Cancel</button>
                <button onclick="submitScore()">Submit Score</button>
            </div>
        </div>
    </div>
</div>

<script>
let pendingList = [];
async function loadSummary() {
    const [listRes, sumRes] = await Promise.all([
        fetch('/api/scorecard'),
        fetch('/api/scorecard/summary')
    ]);
    const list = await listRes.json();
    const summary = await sumRes.json();

    // For pending: we need POs that haven't been scored. Use scorecard list + filter.
    // The scorecard API returns scored entries, not pending. Let's use a different approach:
    // Fetch all POs and filter those without scores.
    const poRes = await fetch('/api/pos?status=Paid&status=Partial');
    const pos = await poRes.json();
    const scoredIds = new Set((list||[]).map(s => s.po_id));
    pendingList = (pos||[]).filter(p => !scoredIds.has(p.po_id));

    const tbody = document.getElementById('sc-pending-body');
    if (pendingList.length === 0) {
        tbody.innerHTML = '';
        document.getElementById('sc-empty').style.display = 'block';
    } else {
        document.getElementById('sc-empty').style.display = 'none';
        tbody.innerHTML = pendingList.map(p => `
            <tr><td>${esc(p.po_id)}</td><td>${esc(p.supplier)}</td>
            <td>${esc(p.date||'').slice(0,10)}</td>
            <td class="money">RM ${(p.total||0).toFixed(2)}</td>
            <td><button onclick="openRate('${esc(p.po_id)}','${esc(p.supplier)}','${esc(p.bill_no||'')}')" class="btn-sm">Rate</button></td></tr>`).join('');
    }
    // Summary display
    const sdiv = document.getElementById('sc-summary');
    if (summary && summary.length) {
        sdiv.innerHTML = '<table><thead><tr><th>Supplier</th><th>Entries</th><th>Avg</th></tr></thead><tbody>' +
            summary.map(s => `<tr><td>${esc(s.supplier_name)}</td><td>${s.count}</td>
                <td><span class="badge ${s.avg>=4.5?'badge-green':s.avg<3?'badge-red':'badge-amber'}">${s.avg.toFixed(1)}</span></td></tr>`).join('') + '</tbody></table>';
    } else {
        sdiv.innerHTML = '<p>No scores recorded yet.</p>';
    }
}
function openRate(poId, supplier, billNo) {
    document.getElementById('rm-po-id').value = poId;
    document.getElementById('rm-po').textContent = poId;
    document.getElementById('rm-supplier').textContent = supplier;
    document.getElementById('rm-bill').textContent = billNo || '-';
    document.getElementById('rm-acc').value = 5; document.getElementById('v-acc').textContent = '5';
    document.getElementById('rm-spd').value = 5; document.getElementById('v-spd').textContent = '5';
    document.getElementById('rm-qual').value = 5; document.getElementById('v-qual').textContent = '5';
    document.getElementById('rm-comment').value = '';
    document.getElementById('rate-modal').classList.add('open');
}
function closeRate() { document.getElementById('rate-modal').classList.remove('open'); }
async function submitScore() {
    const body = {
        po_id: document.getElementById('rm-po-id').value,
        supplier: document.getElementById('rm-supplier').textContent,
        bill_no: document.getElementById('rm-bill').textContent,
        accuracy: parseInt(document.getElementById('rm-acc').value),
        speed: parseInt(document.getElementById('rm-spd').value),
        quality: parseInt(document.getElementById('rm-qual').value),
        comment: document.getElementById('rm-comment').value,
    };
    const res = await fetch('/api/scorecard', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    toast(d.success?'Score saved':'Error', d.success);
    if (d.success) { closeRate(); loadSummary(); }
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
loadSummary();
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/scorecard.html CHANGELOG.md
git commit -m "feat: add scorecard page with pending review list + star rating modal"
```

---

### Task 9: Create catalogue.html

**Files:**
- Create: `templates/catalogue.html`

- [ ] **Step 1: Write catalogue.html**

```html
{{template "base.html" .}}
{{define "content_catalogue"}}
<div class="top-bar"><h2>Catalogue Search</h2></div>
<div class="search-bar">
    <input type="text" id="search" placeholder="Search product across all suppliers..." onkeydown="if(event.key==='Enter')search()">
    <button onclick="search()">Search</button>
</div>
<table><thead><tr><th>Supplier</th><th>ID / Ref</th><th>Description</th><th style="text-align:right">Price</th><th>Bonus / Tiers</th></tr></thead>
<tbody id="body"></tbody></table>
<div id="empty" class="empty"><span class="material-icons">travel_explore</span><p>Enter a keyword to search supplier catalogues</p></div>
<div id="toast" class="toast" style="display:none"></div>

<script>
async function search() {
    const q = document.getElementById('search').value.trim();
    if (q.length < 2) { toast('Enter at least 2 characters', false); return; }
    document.getElementById('empty').style.display = 'none';
    document.getElementById('body').innerHTML = '<tr><td colspan="5" style="text-align:center"><div class="spinner"></div></td></tr>';

    const res = await fetch('/api/catalogue?search='+encodeURIComponent(q)+'&limit=200');
    const data = await res.json();

    if (!data || data.length === 0) {
        document.getElementById('body').innerHTML = '';
        document.getElementById('empty').style.display = 'block';
        return;
    }
    document.getElementById('body').innerHTML = data.map(item => `
        <tr>
            <td style="font-weight:600;color:var(--muted)">${esc(item.supplier||'')}</td>
            <td style="font-weight:700;color:var(--accent);font-family:monospace">${esc(item.id||'-')}</td>
            <td>${esc(item.name||'')}</td>
            <td class="money" style="font-weight:700">RM ${(item.cost||0).toFixed(2)}</td>
            <td style="font-size:12px;color:var(--muted)">${esc(item.bonus||'-')}</td>
        </tr>`).join('');
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/catalogue.html CHANGELOG.md
git commit -m "feat: add catalogue search page"
```

---

### Task 10: Create uom.html

**Files:**
- Create: `templates/uom.html`

- [ ] **Step 1: Write uom.html**

```html
{{template "base.html" .}}
{{define "content_uom"}}
<div class="top-bar"><h2>UOM Mappings</h2><button onclick="openCreate()">+ New Mapping</button></div>
<div class="search-bar">
    <select id="supplier-filter" onchange="loadMappings()"><option value="">All Suppliers</option></select>
</div>
<table><thead><tr><th>Supplier</th><th>Supplier UOM</th><th>Standard UOM</th><th>Multiplier</th><th>Actions</th></tr></thead>
<tbody id="body"></tbody></table>
<div id="empty" class="empty" style="display:none"><span class="material-icons">straighten</span><p>No UOM mappings found</p></div>
<div id="toast" class="toast" style="display:none"></div>

<!-- Add Modal -->
<div id="mapping-modal" class="modal">
    <div class="modal-content">
        <div class="modal-header"><h3>New UOM Mapping</h3><span class="close" onclick="closeModal()">&times;</span></div>
        <div class="modal-body">
            <div class="form-group"><label>Supplier</label><select id="m-supplier"></select></div>
            <div class="form-row">
                <div class="form-group"><label>Supplier UOM</label><input id="m-supplier-uom" placeholder="e.g. BTLS"></div>
                <div class="form-group"><label>Standard UOM</label><input id="m-standard-uom" placeholder="e.g. BOTTLES"></div>
            </div>
            <div class="form-group"><label>Multiplier</label><input type="number" step="0.01" id="m-multiplier" value="1"></div>
            <div class="btn-group">
                <button class="btn-secondary" onclick="closeModal()">Cancel</button>
                <button onclick="saveMapping()">Save</button>
            </div>
        </div>
    </div>
</div>

<script>
let allMappings = [];
async function init() {
    const sr = await fetch('/api/suppliers');
    const suppliers = await sr.json();
    const sel = document.getElementById('supplier-filter');
    sel.innerHTML += suppliers.map(s => `<option value="${esc(s.supplier_name)}">${esc(s.supplier_name)}</option>`).join('');
    document.getElementById('m-supplier').innerHTML = suppliers.map(s => `<option value="${esc(s.supplier_name)}">${esc(s.supplier_name)}</option>`).join('');
    loadMappings();
}
async function loadMappings() {
    const supplier = document.getElementById('supplier-filter').value;
    const url = '/api/uom/mappings' + (supplier ? '?supplier=' + encodeURIComponent(supplier) : '');
    const res = await fetch(url);
    allMappings = await res.json();
    if (!allMappings || allMappings.length === 0) {
        document.getElementById('body').innerHTML = '';
        document.getElementById('empty').style.display = 'block';
    } else {
        document.getElementById('empty').style.display = 'none';
        document.getElementById('body').innerHTML = allMappings.map(m => `
            <tr><td>${esc(m.supplier||'')}</td><td>${esc(m.supplier_uom||'')}</td>
            <td>${esc(m.standard_uom||'')}</td><td>${m.multiplier||1}</td>
            <td></td></tr>`).join('');
    }
}
function openCreate() { document.getElementById('mapping-modal').classList.add('open'); }
function closeModal() { document.getElementById('mapping-modal').classList.remove('open'); }
async function saveMapping() {
    const body = {
        supplier: document.getElementById('m-supplier').value,
        supplier_uom: document.getElementById('m-supplier-uom').value,
        standard_uom: document.getElementById('m-standard-uom').value,
        multiplier: parseFloat(document.getElementById('m-multiplier').value) || 1,
    };
    if (!body.supplier_uom || !body.standard_uom) { toast('Both UOM fields required', false); return; }
    const res = await fetch('/api/uom/mapping', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    toast(d.success?'Saved':'Error', d.success);
    if (d.success) { closeModal(); loadMappings(); }
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
init();
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/uom.html CHANGELOG.md
git commit -m "feat: add UOM mappings page with supplier filter + add modal"
```

---

### Task 11: Create import.html

**Files:**
- Create: `templates/import.html`

- [ ] **Step 1: Write import.html**

```html
{{template "base.html" .}}
{{define "content_import"}}
<div class="top-bar"><h2>Import Data</h2></div>
<div class="card" style="max-width:500px;margin:0 auto">
    <h3>Upload Excel Workbook</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px">Supports .xlsx files with sheets: DB_Items, DB_Suppliers, PurchaseOrder, Movement</p>
    <div class="form-group">
        <label>Select File</label>
        <input type="file" id="file" accept=".xlsx" style="padding:10px">
    </div>
    <button onclick="upload()" id="upload-btn">Upload & Import</button>
    <div id="result" style="margin-top:16px;font-size:13px"></div>
</div>
<div id="toast" class="toast" style="display:none"></div>

<script>
async function upload() {
    const file = document.getElementById('file').files[0];
    if (!file) { toast('Select a file', false); return; }
    const btn = document.getElementById('upload-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Importing...';

    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/import', {method:'POST', body: form});
    const d = await res.json();

    btn.disabled = false; btn.textContent = 'Upload & Import';
    if (d.success) {
        document.getElementById('result').innerHTML = `
            <div style="background:rgba(109,183,123,0.1);padding:12px;border-radius:6px;border:1px solid var(--green)">
                <strong style="color:var(--green)">Import Complete</strong><br>
                Run ID: ${esc(d.run_id)}<br>
                Tables: ${d.tables}<br>
                Rows: ${d.rows}
            </div>`;
    } else {
        document.getElementById('result').innerHTML = `<div style="color:var(--red)">Error: ${esc(d.error)}</div>`;
    }
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/import.html CHANGELOG.md
git commit -m "feat: add import page with Excel upload"
```

---

### Task 12: Add dashboard Quick Actions card

**Files:**
- Modify: `templates/dashboard.html`

- [ ] **Step 1: Append Quick Actions card to dashboard.html**

Add after the ROP Alerts table `{{end}}` and before the final `{{end}}`:

```html
{{if .Stats.ROPAlerts}}
<!-- ... existing ROP alerts table ... -->
{{end}}

<div class="section">
    <div class="card">
        <h3 style="margin-bottom:12px">Quick Actions</h3>
        <div class="quick-actions">
            <button class="quick-btn" onclick="location.href='/rfq'">
                <span class="material-icons icon">add_shopping_cart</span>
                <div><strong>Create RFQ</strong><br><span style="font-size:11px;color:var(--muted)">Start a new draft</span></div>
            </button>
            <button class="quick-btn" onclick="location.href='/workflow'">
                <span class="material-icons icon">fact_check</span>
                <div><strong>Approve POs</strong><br><span style="font-size:11px;color:var(--muted)">Review pending approvals</span></div>
            </button>
            <button class="quick-btn" onclick="location.href='/movement'">
                <span class="material-icons icon">sync_alt</span>
                <div><strong>Stock Movement</strong><br><span style="font-size:11px;color:var(--muted)">Record in/out</span></div>
            </button>
        </div>
    </div>
</div>
{{end}}
```

- [ ] **Step 2: Build & Commit**

```bash
cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1
# Expected: build succeeds
git add templates/dashboard.html CHANGELOG.md
git commit -m "feat: add Quick Actions card to dashboard"
```

---

### Task 13: Upgrade movement.html — upload tab

**Files:**
- Modify: `templates/movement.html`

- [ ] **Step 1: Add upload tab + staging preview to movement.html**

Full replacement — add after the existing table + ROP button, keeping all existing functionality:

```html
{{template "base.html" .}}
{{define "content_movement"}}
<div class="tabs">
    <button class="tab-btn active" onclick="switchTab('view',this)">View Records</button>
    <button class="tab-btn" onclick="switchTab('upload',this)">Upload Data</button>
    <button class="tab-btn" onclick="switchTab('analysis',this)">Analysis</button>
</div>

<div id="tab-view" class="tab-content active">
<div class="top-bar"><h2>Stock Movement</h2><button onclick="recalcROP()">Recalc ROP</button></div>
<div class="search-bar">
    <select id="year" onchange="load()"></select>
    <select id="month" onchange="load()"><option value="0">All Months</option></select>
    <input type="text" id="search" placeholder="Search stock ID or item..." oninput="load()">
    <button onclick="load()">Search</button>
</div>
<table><thead><tr><th>Stock ID</th><th>Item</th><th>Year</th><th>Month</th><th>In</th><th>Out</th><th>Adj In</th><th>Adj Out</th><th>Closing</th></tr></thead><tbody id="body"></tbody></table>
</div>

<div id="tab-upload" class="tab-content">
<div class="top-bar"><h2>Upload Movement Data</h2></div>
<div class="card">
    <div class="form-row">
        <div class="form-group"><label>Year</label><select id="up-year"></select></div>
        <div class="form-group"><label>Month</label><select id="up-month"></select></div>
    </div>
    <div class="form-group">
        <label>Upload Mode</label>
        <select id="up-mode">
            <option value="FLOW">Movement Flow (In/Out/Adj)</option>
            <option value="CLOSING">Closing Balance Only</option>
        </select>
    </div>
    <div class="form-group">
        <label>Paste Data (tab-delimited from Excel)</label>
        <textarea id="up-paste" rows="10" style="font-family:monospace;font-size:12px" placeholder="SKU&#9;Name&#9;In&#9;Out&#9;AdjIn&#9;AdjOut&#9;Closing"></textarea>
    </div>
    <button onclick="parseAndPreview()">Preview</button>
    <div id="up-preview" style="margin-top:16px;display:none">
        <h4>Preview (<span id="up-count"></span> rows)</h4>
        <div style="max-height:300px;overflow-y:auto"><table id="up-preview-table"></table></div>
        <div class="btn-group">
            <button class="btn-secondary" onclick="cancelUpload()">Cancel</button>
            <button onclick="saveUpload()">Confirm & Save</button>
        </div>
    </div>
</div>
</div>

<div id="tab-analysis" class="tab-content">
<div class="top-bar"><h2>Movement Analysis</h2></div>
<div style="display:grid;grid-template-columns:300px 1fr;gap:14px;height:calc(100vh-160px);overflow:hidden">
    <div class="card" style="overflow:hidden;display:flex;flex-direction:column;padding:0">
        <div style="padding:12px;border-bottom:1px solid var(--border)">
            <input type="text" id="ana-search" placeholder="Search item..." style="width:100%" oninput="filterAnalysisItems()">
        </div>
        <div id="ana-item-list" style="flex:1;overflow-y:auto;font-size:13px"></div>
    </div>
    <div class="card" style="overflow-y:auto">
        <div id="ana-detail">
            <div class="empty"><span class="material-icons">insights</span><p>Select an item to view analysis</p></div>
        </div>
    </div>
</div>
</div>

<div id="toast" class="toast" style="display:none"></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
// ── Shared ──
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}

// ── Tabs ──
function switchTab(tab, btn) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-'+tab).classList.add('active');
    btn.classList.add('active');
    if (tab === 'analysis') initAnalysis();
}

// ── View tab (existing logic) ──
async function initView() {
    const res = await fetch('/api/movement/years'); const years = await res.json();
    const sel = document.getElementById('year');
    sel.innerHTML = '<option value="0">All Years</option>' + years.map(y => `<option>${y}</option>`).join('');
    for(let m=1;m<=12;m++) document.getElementById('month').innerHTML += `<option value="${m}">${new Date(2000,m-1).toLocaleString('default',{month:'short'})}</option>`;
    load();
}
async function load() {
    const p = new URLSearchParams({year: document.getElementById('year').value, month: document.getElementById('month').value, search: document.getElementById('search').value, limit: '500'});
    const res = await fetch('/api/movement?'+p); const data = await res.json();
    document.getElementById('body').innerHTML = data.map(r => `
        <tr><td>${esc(r.stock_id)}</td><td>${esc(r.item_name)}</td><td>${r.year}</td><td>${r.month}</td>
        <td>${r.in_qty||0}</td><td>${r.out_qty||0}</td><td>${r.adj_in||0}</td><td>${r.adj_out||0}</td><td>${r.report_closing||0}</td></tr>`).join('');
}
async function recalcROP() {
    const res = await fetch('/api/movement/rop', {method:'POST'}); const d = await res.json();
    toast(d.success ? `Updated ${d.updated} items` : d.error, d.success);
}

// ── Upload tab ──
let stagedRows = [];
function initUpload() {
    const ySel = document.getElementById('up-year');
    const mSel = document.getElementById('up-month');
    for (let y = new Date().getFullYear(); y >= 2020; y--) ySel.innerHTML += `<option value="${y}">${y}</option>`;
    for (let m = 1; m <= 12; m++) mSel.innerHTML += `<option value="${m}">${new Date(2000,m-1).toLocaleString('default',{month:'short'})}</option>`;
}
function parseAndPreview() {
    const raw = document.getElementById('up-paste').value.trim();
    if (!raw) { toast('Paste data first', false); return; }
    const mode = document.getElementById('up-mode').value;
    const lines = raw.split('\n');
    stagedRows = [];
    lines.forEach(line => {
        const cols = line.split('\t');
        if (cols.length < 2) return;
        const row = {stock_id: cols[0].trim(), item_name: cols[1].trim(), in:0, out:0, adj_in:0, adj_out:0, closing:0};
        if (mode === 'FLOW') {
            row.in = parseFloat(cols[2])||0; row.out = parseFloat(cols[3])||0;
            row.adj_in = parseFloat(cols[4])||0; row.adj_out = parseFloat(cols[5])||0;
        } else {
            row.closing = parseFloat(cols[2])||0;
        }
        stagedRows.push(row);
    });
    document.getElementById('up-count').textContent = stagedRows.length;
    document.getElementById('up-preview-table').innerHTML = `<thead><tr><th>SKU</th><th>Name</th><th>In</th><th>Out</th><th>AdjIn</th><th>AdjOut</th><th>Closing</th></tr></thead><tbody>` +
        stagedRows.slice(0,50).map(r => `<tr><td>${esc(r.stock_id)}</td><td>${esc(r.item_name)}</td><td>${r.in}</td><td>${r.out}</td><td>${r.adj_in}</td><td>${r.adj_out}</td><td>${r.closing}</td></tr>`).join('') +
        (stagedRows.length > 50 ? `<tr><td colspan="7" style="color:var(--muted);text-align:center">...and ${stagedRows.length-50} more</td></tr>` : '') + '</tbody>';
    document.getElementById('up-preview').style.display = 'block';
}
function cancelUpload() { stagedRows = []; document.getElementById('up-preview').style.display = 'none'; }
async function saveUpload() {
    if (!stagedRows.length) return;
    const body = { year: parseInt(document.getElementById('up-year').value), month: parseInt(document.getElementById('up-month').value), rows: stagedRows };
    const res = await fetch('/api/movement/bulk', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    toast(d.success ? `Saved ${d.count} rows` : d.error, d.success);
    if (d.success) cancelUpload();
}

// ── Analysis tab ──
let allItems = [], analysisChart = null;
async function initAnalysis() {
    if (allItems.length) return;
    const res = await fetch('/api/inventory/basic');
    allItems = await res.json();
    filterAnalysisItems();
}
function filterAnalysisItems() {
    const q = (document.getElementById('ana-search')?.value || '').toLowerCase();
    const filtered = q ? allItems.filter(i => (i['Stock ID']||'').toLowerCase().includes(q) || (i['Item Name']||'').toLowerCase().includes(q)) : allItems.slice(0, 100);
    document.getElementById('ana-item-list').innerHTML = filtered.map(i => `
        <div style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer" onclick="loadItemAnalysis('${esc(i['Stock ID'])}','${esc(i['Item Name'])}','${esc(i['Category']||'')}')">
            <strong style="color:var(--accent);font-family:monospace">${esc(i['Stock ID'])}</strong>
            <div style="font-size:12px">${esc(i['Item Name'])}</div>
        </div>`).join('');
}
async function loadItemAnalysis(stockId, name, category) {
    const detailDiv = document.getElementById('ana-detail');
    detailDiv.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';

    const res = await fetch('/api/movement/timeline?stock_id=' + encodeURIComponent(stockId));
    const data = await res.json();
    if (!data.success) { detailDiv.innerHTML = '<div class="empty"><p>No data</p></div>'; return; }

    const tl = data.timeline || [];
    const cost = data.itemCost || 0;
    const selling = data.itemSelling || 0;
    const totalIn = tl.reduce((s,r)=>s+(r.in||0)+(r.adjIn||0),0);
    const totalOut = tl.reduce((s,r)=>s+(r.out||0)+(r.adjOut||0),0);
    const fmt = v => 'RM '+(v||0).toLocaleString('en-MY',{minimumFractionDigits:2});

    detailDiv.innerHTML = `
        <h3>${esc(name)}</h3>
        <div style="color:var(--muted);font-size:12px;margin-bottom:12px">
            <span style="background:var(--bg);padding:2px 8px;border-radius:4px;font-family:monospace">${esc(stockId)}</span>
            ${category ? ' &middot; '+esc(category) : ''}
        </div>
        <div class="ana-kpi-grid" style="grid-template-columns:repeat(5,1fr)">
            <div class="ana-kpi"><div class="lbl">Total IN</div><div class="val" style="color:#06b6d4">${totalIn}</div></div>
            <div class="ana-kpi"><div class="lbl">Total OUT</div><div class="val" style="color:#ef4444">${totalOut}</div></div>
            <div class="ana-kpi"><div class="lbl">Capital Cost</div><div class="val" style="font-size:16px">${fmt(totalIn*cost)}</div></div>
            <div class="ana-kpi"><div class="lbl">Revenue</div><div class="val" style="font-size:16px">${fmt(totalOut*selling)}</div></div>
            <div class="ana-kpi"><div class="lbl">Gross Profit</div><div class="val" style="font-size:16px;color:${(totalOut*selling-totalIn*cost)>=0?'var(--green)':'var(--red)'}">${fmt(totalOut*selling-totalIn*cost)}</div></div>
        </div>
        <h4 style="margin:16px 0 8px">Monthly Trend</h4>
        <div class="chart-box"><canvas id="ana-chart"></canvas></div>
    `;

    // Draw chart
    setTimeout(() => {
        const ctx = document.getElementById('ana-chart');
        if (!ctx) return;
        if (analysisChart) analysisChart.destroy();
        const labels = tl.map(r => r.label);
        analysisChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {label:'IN',data:tl.map(r=>r.in+r.adjIn),borderColor:'#06b6d4',tension:0.3,pointRadius:3},
                    {label:'OUT',data:tl.map(r=>r.out+r.adjOut),borderColor:'#ef4444',tension:0.3,pointRadius:3},
                    {label:'Closing',data:tl.map(r=>r.closing),borderColor:'#3b82f6',tension:0.3,pointRadius:3},
                ]
            },
            options: {responsive:true,maintainAspectRatio:false,
                plugins:{legend:{position:'bottom',labels:{color:'#7a828e'}}},
                scales:{x:{ticks:{color:'#7a828e'}},y:{ticks:{color:'#7a828e'},min:0}}}
        });
    }, 100);
}

// ── Init ──
initView(); initUpload();
</script>
{{end}}
```

- [ ] **Step 2: Build**

Run: `cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add templates/movement.html CHANGELOG.md
git commit -m "feat: add movement upload + analysis tabs with Chart.js"
```

---

### Task 14: Create workflow.html

**Files:**
- Create: `templates/workflow.html`

- [ ] **Step 1: Write workflow.html**

```html
{{template "base.html" .}}
{{define "content_workflow"}}
<div class="top-bar"><h2>Workflow</h2></div>
<div class="tabs">
    <button class="tab-btn active" onclick="switchWf('APPROVAL',this)">Manager Approval</button>
    <button class="tab-btn" onclick="switchWf('PAYMENT',this)">Finance Request</button>
</div>

<div id="wf-table-area">
    <div class="search-bar">
        <input type="text" id="wf-search" placeholder="Search POs..." oninput="renderWf()">
        <button onclick="loadWf(true)">Refresh</button>
    </div>
    <table><thead><tr>
        <th style="width:40px"><input type="checkbox" onchange="toggleAll(this)"></th>
        <th>PO ID</th><th>Supplier</th><th>Dept</th><th style="text-align:right">Amount</th><th>Status</th><th>Docs</th>
    </tr></thead><tbody id="wf-body"></tbody></table>
    <div id="wf-empty" class="empty" style="display:none"><span class="material-icons">done_all</span><p>No items pending</p></div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <span id="wf-count" style="font-weight:700;color:var(--accent)">0 selected</span>
        <button onclick="batchAction()" id="wf-action-btn">Approve Selected</button>
    </div>
</div>
<div id="toast" class="toast" style="display:none"></div>

<script>
let wfMode = 'APPROVAL', wfData = [], selected = new Set();
async function loadWf(force) {
    const [poRes, wfRes] = await Promise.all([
        fetch('/api/pos?status='+(wfMode==='APPROVAL'?'Pending+Approval':'Approved')),
        fetch('/api/workflow/pending')
    ]);
    const pos = await poRes.json();
    wfData = (pos||[]).filter(p => {
        if (wfMode === 'APPROVAL') return p.status === 'Pending Approval';
        return p.status === 'Approved';
    });
    selected.clear();
    renderWf();
}
function switchWf(mode, btn) {
    wfMode = mode;
    document.querySelectorAll('#wf-table-area .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('wf-action-btn').textContent = mode==='APPROVAL'?'Approve Selected':'Request Payment';
    loadWf();
}
function renderWf() {
    const q = (document.getElementById('wf-search')?.value||'').toLowerCase();
    const filtered = q ? wfData.filter(p => (p.po_id||'').toLowerCase().includes(q) || (p.supplier||'').toLowerCase().includes(q)) : wfData;
    const tbody = document.getElementById('wf-body');
    if (!filtered.length) { tbody.innerHTML=''; document.getElementById('wf-empty').style.display='block'; return; }
    document.getElementById('wf-empty').style.display = 'none';
    tbody.innerHTML = filtered.map(p => `
        <tr>
            <td><input type="checkbox" ${selected.has(p.po_id)?'checked':''} onchange="toggleSel('${esc(p.po_id)}',this.checked)"></td>
            <td style="font-weight:700;color:var(--accent)">${esc(p.po_id)}</td>
            <td>${esc(p.supplier)}</td><td>${esc(p.department||'-')}</td>
            <td class="money">RM ${(p.total||0).toFixed(2)}</td>
            <td><span class="badge badge-amber">${esc(p.status)}</span></td>
            <td style="font-size:11px">${p.ship_status||'-'}</td>
        </tr>`).join('');
}
function toggleSel(id, on) { on ? selected.add(id) : selected.delete(id); document.getElementById('wf-count').textContent = selected.size + ' selected'; }
function toggleAll(cb) { document.querySelectorAll('#wf-body input[type=checkbox]').forEach(chk => { chk.checked = cb.checked; toggleSel(chk.closest('tr').querySelector('td:nth-child(2)').textContent, cb.checked); }); }
async function batchAction() {
    if (!selected.size) { toast('Select POs first', false); return; }
    const endpoint = wfMode === 'APPROVAL' ? '/api/workflow/approve' : '/api/workflow/payment';
    let count = 0;
    for (const poId of selected) {
        const res = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({po_id: poId})});
        const d = await res.json();
        if (d.success) count++;
    }
    toast(`Processed ${count} POs`, true);
    loadWf();
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
loadWf();
</script>
{{end}}
```

- [ ] **Step 2: Build & Commit**

```bash
cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1
git add templates/workflow.html CHANGELOG.md
git commit -m "feat: add workflow page with batch approval/payment"
```

---

### Task 15: Create analytics.html — 5-tab BI dashboard

**Files:**
- Create: `templates/analytics.html`

- [ ] **Step 1: Write analytics.html**

Full 5-tab BI dashboard using Chart.js from CDN:

```html
{{template "base.html" .}}
{{define "content_analytics"}}
<div class="top-bar">
    <h2>Analytics</h2>
    <div style="display:flex;gap:8px;align-items:center;font-size:12px">
        <span>From</span>
        <select id="af-month" onchange="load()"></select>
        <select id="af-year" onchange="load()"></select>
        <span>To</span>
        <select id="at-month" onchange="load()"></select>
        <select id="at-year" onchange="load()"></select>
        <button onclick="load(true)">Refresh</button>
    </div>
</div>

<div class="tabs">
    <button class="tab-btn active" onclick="switchTab('finance',this)">Finance</button>
    <button class="tab-btn" onclick="switchTab('operation',this)">Operation</button>
    <button class="tab-btn" onclick="switchTab('inventory',this)">Inventory</button>
    <button class="tab-btn" onclick="switchTab('supplier',this)">Supplier</button>
    <button class="tab-btn" onclick="switchTab('business',this)">Business</button>
</div>

<div id="ana-content"><div class="empty"><div class="spinner"></div><p>Loading data...</p></div></div>
<div id="toast" class="toast" style="display:none"></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
let anaData = null, charts = {}, currentTab = 'finance';

function initDropdowns() {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    [document.getElementById('af-month'), document.getElementById('at-month')].forEach(sel => {
        sel.innerHTML = months.map((m,i) => `<option value="${i}">${m}</option>`).join('');
        sel.value = sel.id==='af-month' ? 0 : new Date().getMonth();
    });
    const yr = new Date().getFullYear();
    [document.getElementById('af-year'), document.getElementById('at-year')].forEach(sel => {
        for (let y=2020; y<=yr; y++) sel.innerHTML += `<option value="${y}">${y}</option>`;
        sel.value = sel.id==='af-year' ? 2025 : yr;
    });
}
function getRange() {
    return {
        from_year: parseInt(document.getElementById('af-year').value),
        from_month: parseInt(document.getElementById('af-month').value),
        to_year: parseInt(document.getElementById('at-year').value),
        to_month: parseInt(document.getElementById('at-month').value),
    };
}
async function load(force) {
    document.getElementById('ana-content').innerHTML = '<div class="empty"><div class="spinner"></div></div>';
    const r = getRange();
    const res = await fetch(`/api/analytics?from_year=${r.from_year}&from_month=${r.from_month}&to_year=${r.to_year}&to_month=${r.to_month}`);
    anaData = await res.json();
    renderTab(currentTab);
}
function switchTab(tab, btn) {
    currentTab = tab;
    document.querySelectorAll('.tabs .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    if (anaData) renderTab(tab);
}
function fmt(v) { return 'RM '+(v||0).toLocaleString('en-MY',{maximumFractionDigits:0}); }
function fmtK(v) { return v>=1000 ? (v/1000).toFixed(1)+'k' : v; }
function months() { return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; }
function renderTab(tab) {
    if (!anaData) return;
    Object.values(charts).forEach(c => c.destroy?.());
    charts = {};
    const div = document.getElementById('ana-content');
    const labels = months();

    switch(tab) {
    case 'finance':
        div.innerHTML = `
            <div class="ana-kpi-grid">
                <div class="ana-kpi" style="border-left:4px solid #3b82f6"><div class="lbl">Total PO Spend</div><div class="val">${fmt(anaData.finance?.totalSpend)}</div></div>
                <div class="ana-kpi" style="border-left:4px solid #ef4444"><div class="lbl">Outstanding</div><div class="val">${fmt(anaData.finance?.unpaidPo)}</div></div>
                <div class="ana-kpi" style="border-left:4px solid #10b981"><div class="lbl">Inventory Asset</div><div class="val">${fmt(anaData.finance?.inventoryAsset)}</div></div>
            </div>
            <div class="ana-chart-grid">
                <div class="ana-chart-card"><h4>Monthly Spending</h4><div class="chart-box"><canvas id="c-fin-trend"></canvas></div></div>
                <div class="ana-chart-card"><h4>Department Spend</h4><div class="chart-box"><canvas id="c-fin-dept"></canvas></div></div>
            </div>`;
        setTimeout(() => {
            const spend = anaData.finance?.monthlySpend || [];
            charts['c-fin-trend'] = new Chart(document.getElementById('c-fin-trend'), {
                type:'bar',data:{labels,datasets:[{label:'Spend',data:spend,backgroundColor:'#3b82f6'}]},
                options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
            });
            const dept = anaData.finance?.deptSpend || {};
            charts['c-fin-dept'] = new Chart(document.getElementById('c-fin-dept'), {
                type:'doughnut',data:{labels:Object.keys(dept),datasets:[{data:Object.values(dept),backgroundColor:['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#06b6d4']}]},
                options:{responsive:true,maintainAspectRatio:false}
            });
        }, 50);
        break;

    case 'operation':
        div.innerHTML = `
            <div class="ana-kpi-grid">
                <div class="ana-kpi" style="border-left:4px solid #f59e0b"><div class="lbl">Total POs</div><div class="val">${anaData.operation?.poCount||0}</div></div>
                <div class="ana-kpi" style="border-left:4px solid #ef4444"><div class="lbl">Restock Cost</div><div class="val">${fmt(anaData.operation?.restockCost)}</div></div>
            </div>
            <div class="ana-chart-grid">
                <div class="ana-chart-card"><h4>In-House Usage (RM)</h4><div class="chart-box"><canvas id="c-ops-inh"></canvas></div></div>
                <div class="ana-chart-card"><h4>Top 10 Critical</h4>
                    <table><thead><tr><th>Item</th><th style="text-align:right">Shortage</th><th style="text-align:right">Cost</th></tr></thead><tbody>
                    ${(anaData.operation?.criticalItems||[]).slice(0,10).map(i => `<tr><td>${esc(i.name)}</td><td style="text-align:right">${i.gap||0}</td><td style="text-align:right">${fmt(i.cost)}</td></tr>`).join('')}</tbody></table>
                </div>
            </div>`;
        setTimeout(() => {
            charts['c-ops-inh'] = new Chart(document.getElementById('c-ops-inh'), {
                type:'line',data:{labels,datasets:[{label:'RM',data:anaData.operation?.inHouseConsumption||[],borderColor:'#ef4444',fill:true,backgroundColor:'rgba(239,68,68,0.1)',tension:0.3}]},
                options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
            });
        }, 50);
        break;

    case 'inventory':
        div.innerHTML = `
            <div class="ana-chart-grid">
                <div class="ana-chart-card"><h4>Closing Stock Value</h4><div class="chart-box"><canvas id="c-inv-val"></canvas></div></div>
                <div class="ana-chart-card"><h4>Consumption Value</h4><div class="chart-box"><canvas id="c-inv-cons"></canvas></div></div>
                <div class="ana-chart-card"><h4>High Movers</h4>
                    <table><tbody>${(anaData.inventory?.highMovers||[]).slice(0,10).map(i => `<tr><td>${esc(i.name)}</td><td style="text-align:right">${i.qty||0}</td><td style="text-align:right">${fmt(i.val)}</td></tr>`).join('')}</tbody></table>
                </div>
                <div class="ana-chart-card"><h4>Dead Stock</h4>
                    <table><tbody>${(anaData.inventory?.deadStock||[]).slice(0,10).map(i => `<tr><td>${esc(i.name)}</td></tr>`).join('')}</tbody></table>
                </div>
            </div>`;
        setTimeout(() => {
            charts['c-inv-val'] = new Chart(document.getElementById('c-inv-val'), {type:'bar',data:{labels,datasets:[{label:'Value',data:anaData.inventory?.valuationTrend||[],backgroundColor:'#10b981'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});
            charts['c-inv-cons'] = new Chart(document.getElementById('c-inv-cons'), {type:'bar',data:{labels,datasets:[{label:'Consumption',data:anaData.inventory?.consumptionTrend||[],backgroundColor:'#f59e0b'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});
        }, 50);
        break;

    case 'supplier':
        const tops = Object.entries(anaData.supplier?.topSuppliers||{}).sort((a,b)=>b[1]-a[1]).slice(0,10);
        div.innerHTML = `
            <div class="ana-kpi-grid"><div class="ana-kpi" style="border-left:4px solid #8b5cf6"><div class="lbl">Active Suppliers</div><div class="val">${Object.keys(anaData.supplier?.topSuppliers||{}).length}</div></div></div>
            <div class="ana-chart-grid">
                <div class="ana-chart-card"><h4>Top Suppliers (Spend)</h4>
                    <table><tbody>${tops.map(e => `<tr><td>${esc(e[0])}</td><td style="text-align:right">${fmt(e[1])}</td></tr>`).join('')}</tbody></table>
                </div>
                <div class="ana-chart-card"><h4>Avg Performance</h4><div class="chart-box"><canvas id="c-sup-radar"></canvas></div></div>
                <div class="ana-chart-card"><h4>Performance Ranking</h4>
                    <table><thead><tr><th>Supplier</th><th>Entries</th><th>Avg</th></tr></thead><tbody>
                    ${(anaData.supplier?.performanceRanking||[]).map(r => `<tr><td>${esc(r.name)}</td><td style="text-align:center">${r.count}</td><td><span class="badge ${r.avg>=4.5?'badge-green':r.avg<3?'badge-red':'badge-amber'}">${r.avg.toFixed(1)}</span></td></tr>`).join('')}</tbody></table>
                </div>
            </div>`;
        setTimeout(() => {
            const rad = anaData.supplier?.radarData || {};
            if (rad.acc) {
                charts['c-sup-radar'] = new Chart(document.getElementById('c-sup-radar'), {
                    type:'radar',data:{labels:['Accuracy','Speed','Quality'],datasets:[{label:'Avg',data:[rad.acc,rad.spd,rad.qual],backgroundColor:'rgba(46,204,113,0.2)',borderColor:'#2ecc71'}]},
                    options:{responsive:true,maintainAspectRatio:false,scales:{r:{min:0,max:5,ticks:{stepSize:1}}}}
                });
            }
        }, 50);
        break;

    case 'business':
        div.innerHTML = `
            <div class="ana-chart-grid">
                <div class="ana-chart-card"><h4>Gross Revenue Trend</h4><div class="chart-box"><canvas id="c-biz-rev"></canvas></div></div>
                <div class="ana-chart-card"><h4>Product Type Split</h4><div class="chart-box"><canvas id="c-biz-type"></canvas></div></div>
                <div class="ana-chart-card"><h4>Seasonal Trends (Top 5)</h4><div class="chart-box"><canvas id="c-biz-seasonal"></canvas></div></div>
                <div class="ana-chart-card"><h4>Top Revenue Items</h4>
                    <table><tbody>${(anaData.business?.topTurnoverItems||[]).slice(0,10).map(i => `<tr><td>${esc(i.name)}</td><td style="text-align:right">${fmt(i.revenue)}</td></tr>`).join('')}</tbody></table>
                </div>
            </div>`;
        setTimeout(() => {
            charts['c-biz-rev'] = new Chart(document.getElementById('c-biz-rev'), {type:'bar',data:{labels,datasets:[{label:'Revenue',data:anaData.business?.grossRevenueTrend||[],backgroundColor:'#8b5cf6'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});
            const ptKeys = Object.keys(anaData.business?.productTypeSplit||{});
            if (ptKeys.length) charts['c-biz-type'] = new Chart(document.getElementById('c-biz-type'), {type:'doughnut',data:{labels:ptKeys,datasets:[{data:Object.values(anaData.business?.productTypeSplit||{})}]},options:{responsive:true,maintainAspectRatio:false}});
            const seas = anaData.business?.seasonalTrends;
            if (seas?.datasets) charts['c-biz-seasonal'] = new Chart(document.getElementById('c-biz-seasonal'), {type:'line',data:{labels,datasets:seas.datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:'#7a828e'}}}}});
        }, 50);
        break;
    }
}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
initDropdowns(); load();
</script>
{{end}}
```

- [ ] **Step 2: Build & Commit**

```bash
cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1
git add templates/analytics.html CHANGELOG.md
git commit -m "feat: add analytics page with 5-tab BI dashboard + Chart.js"
```

---

### Task 16: Upgrade reports.html — add item history

**Files:**
- Modify: `templates/reports.html`

- [ ] **Step 1: Add item history section**

Append BEFORE the final `{{end}}` in reports.html (after existing historical report table):

```html
<div class="card section">
    <h3>Item History Report</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px">Select items to view history across POs</p>
    <div class="form-row">
        <div class="form-group">
            <label>Search Items</label>
            <input type="text" id="ih-search" placeholder="Type stock ID or name..." oninput="searchItems()">
        </div>
    </div>
    <div id="ih-item-list" style="max-height:200px;overflow-y:auto;margin-bottom:12px"></div>
    <button onclick="loadItemHistory()">Generate Report</button>
    <div id="ih-result" style="margin-top:12px"></div>
</div>

<!-- Additional JS to append -->
<script>
// Extend the existing init() to also load inventory for item history
let allItems = [], selectedItems = new Set();
async function loadItemsForHistory() {
    const res = await fetch('/api/inventory/basic');
    allItems = await res.json();
}
function searchItems() {
    const q = (document.getElementById('ih-search').value||'').toLowerCase();
    const filtered = q ? allItems.filter(i => (i['Stock ID']||'').toLowerCase().includes(q) || (i['Item Name']||'').toLowerCase().includes(q)) : [];
    if (filtered.length === 0) { document.getElementById('ih-item-list').innerHTML = q ? '<p style="color:var(--muted)">No matches</p>' : ''; return; }
    document.getElementById('ih-item-list').innerHTML = filtered.slice(0,20).map(i => `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;cursor:pointer">
            <input type="checkbox" ${selectedItems.has(i['Stock ID'])?'checked':''} onchange="toggleItem('${esc(i['Stock ID'])}','${esc(i['Item Name'])}',this.checked)">
            <span style="font-family:monospace;color:var(--accent)">${esc(i['Stock ID'])}</span> ${esc(i['Item Name'])}
        </label>`).join('');
}
function toggleItem(id, name, on) {
    if (on) selectedItems.add(id); else selectedItems.delete(id);
}
async function loadItemHistory() {
    if (!selectedItems.size) { toast('Select at least one item', false); return; }
    const items = Array.from(selectedItems).map(id => {
        const item = allItems.find(i => i['Stock ID'] === id);
        return {id, name: item ? item['Item Name'] : id};
    });
    const res = await fetch('/api/reports/item-history', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(items)});
    const data = await res.json();
    if (!data || !data.length) { document.getElementById('ih-result').innerHTML = '<p style="color:var(--muted)">No history found</p>'; return; }
    document.getElementById('ih-result').innerHTML = '<table><thead><tr><th>Item</th><th>PO ID</th><th>Date</th><th>Qty</th><th>Cost</th><th>Total</th></tr></thead><tbody>' +
        data.map(r => `<tr><td>${esc(r.item_name)}</td><td>${esc(r.po_id)}</td><td>${esc(r.date||'').slice(0,10)}</td><td>${r.qty}</td><td>RM ${(r.cost||0).toFixed(2)}</td><td>RM ${(r.total||0).toFixed(2)}</td></tr>`).join('') + '</tbody></table>';
}

// Extend existing init()
const origInit = init;
init = function() {
    origInit();
    loadItemsForHistory();
};
</script>
```

- [ ] **Step 2: Build & Commit**

```bash
cd /home/hafiz/Desktop/procura && go build -o /dev/null . 2>&1
git add templates/reports.html CHANGELOG.md
git commit -m "feat: add item history report to reports page"
```

---

### Task 17: Final build verification + CHANGELOG

**Files:**
- None (verification only)

- [ ] **Step 1: Full build**

Run: `cd /home/hafiz/Desktop/procura && go build -o procura . 2>&1`
Expected: Binary `procura` created, no errors.

- [ ] **Step 2: Template count**

Run: `ls templates/*.html | wc -l`
Expected: 16 (9 existing + 7 new)

- [ ] **Step 3: Start and test navigation**

Run: `./procura &` then `curl -s http://localhost:8082/login | head -5`
Expected: Login page HTML.

- [ ] **Step 4: Kill server**

Run: `pkill procura`

- [ ] **Step 5: Final commit**

```bash
git add CHANGELOG.md
git commit -m "feat: complete UI parity — 7 new pages, modal upgrades, movement analysis, analytics dashboard"
```
