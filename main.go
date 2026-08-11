package main

import (
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"procura/internal/analytics"
	"procura/internal/auth"
	"procura/internal/catalogue"
	"procura/internal/core"
	"procura/internal/dashboard"
	ximport "procura/internal/import"
	"procura/internal/inventory"
	"procura/internal/movement"
	"procura/internal/pdf"
	"procura/internal/planning"
	"procura/internal/po"
	"procura/internal/report"
	"procura/internal/rfq"
	"procura/internal/scorecard"
	"procura/internal/suppliers"
	"procura/internal/tasks"
	"procura/internal/uom"
	"procura/internal/validation"
	"procura/internal/workflow"
)

//go:embed templates static
var assets embed.FS

var (
	logoB64 string
	signB64 string
)

func main() {
	db, err := core.Open("data")
	if err != nil {
		log.Fatal(err)
	}

	// Load logo and signature from embedded static
	if b, err := assets.ReadFile("static/logo.png"); err == nil {
		logoB64 = base64.StdEncoding.EncodeToString(b)
	}
	if b, err := assets.ReadFile("static/sign.png"); err == nil {
		signB64 = base64.StdEncoding.EncodeToString(b)
	}

	authSvc := &auth.Service{DB: db}
	if pin := authSvc.BootstrapAdmin(); pin != "" {
		log.Printf("*** FIRST RUN: admin user created — email: admin@procura.local  PIN: %s ***", pin)
	}

	dashSvc := &dashboard.Service{DB: db}
	invSvc := &inventory.Service{DB: db}
	supSvc := &suppliers.Service{DB: db}
	planSvc := &planning.Service{DB: db}
	poSvc := &po.Service{DB: db}
	rfqSvc := &rfq.Service{DB: db}
	movSvc := &movement.Service{DB: db}
	repSvc := &report.Service{DB: db}
	taskSvc := &tasks.Service{DB: db}
	scoreSvc := &scorecard.Service{DB: db}
	wfSvc := &workflow.Service{DB: db}
	analyticsSvc := &analytics.Service{DB: db}
	catalogueSvc := &catalogue.Service{DB: db}
	uomSvc := &uom.Service{DB: db}
	importSvc := &ximport.Service{DB: db, ImportsDir: "data/imports"}
	validationSvc := &validation.Service{DB: db}

	tmpl := template.Must(template.ParseFS(assets, "templates/*.html"))

	mux := http.NewServeMux()

	// Static files
	staticFS, _ := fs.Sub(assets, "static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	// ── Public ──
	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "login.html", nil)
	})

	mux.HandleFunc("POST /api/login", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
			PIN   string `json:"pin"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		token, claims, err := authSvc.Login(body.Email, body.PIN)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: "token", Value: token, Path: "/",
			HttpOnly: true, MaxAge: 8 * 3600, SameSite: http.SameSiteLaxMode,
		})
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success": true, "user": claims,
			"mustChangePin": authSvc.MustChangePIN(claims.Email),
		})
	})

	// ── Logout ──
	mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name: "token", Value: "", Path: "/",
			HttpOnly: true, MaxAge: -1, SameSite: http.SameSiteLaxMode,
		})
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
	})

	// ── Protected pages ──
	protected := authSvc.Middleware
	adminOnly := func(next http.HandlerFunc) http.HandlerFunc {
		return protected(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-User-Role") != "ADMIN" {
				writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "Admin only"})
				return
			}
			next(w, r)
		})
	}

	// ── Users page ──
	mux.HandleFunc("GET /users", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{
			"Active": "users", "ContentBlock": "content_users",
			"User": userFromReq(r), "Users": authSvc.ListUsers(),
		})
	}))

	// ── User API (admin only) ──
	mux.HandleFunc("GET /api/users", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, authSvc.ListUsers())
	}))
	mux.HandleFunc("POST /api/users", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
			Name  string `json:"name"`
			Role  string `json:"role"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.Role == "" {
			body.Role = "VIEWER"
		}
		pin, err := authSvc.AddUser(body.Email, body.Name, body.Role)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "pin": pin})
	}))
	mux.HandleFunc("PUT /api/users", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
			Name  string `json:"name"`
			Role  string `json:"role"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := authSvc.UpdateUser(body.Email, body.Name, body.Role); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
	}))
	mux.HandleFunc("POST /api/users/reset-pin", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Email string `json:"email"` }
		json.NewDecoder(r.Body).Decode(&body)
		pin, err := authSvc.ResetUserPIN(body.Email)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "pin": pin})
	}))
	mux.HandleFunc("DELETE /api/users", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Email string `json:"email"` }
		json.NewDecoder(r.Body).Decode(&body)
		if err := authSvc.DeleteUser(body.Email); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
	}))

	mux.HandleFunc("GET /change-pin", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "change_pin.html", map[string]interface{}{
			"User": userFromReq(r),
		})
	}))

	mux.HandleFunc("GET /", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{
			"Active": "dashboard", "ContentBlock": "content_dashboard",
			"User": userFromReq(r),
			"Stats": dashSvc.Compute(),
		})
	}))

	mux.HandleFunc("GET /items", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{
			"Active": "inventory", "ContentBlock": "content_inventory",
			"User": userFromReq(r),
		})
	}))

	// ── Bootstrap ──
	mux.HandleFunc("GET /api/bootstrap", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"user":      userFromReq(r),
			"suppliers": supSvc.List(""),
			"items":     invSvc.List("", 1, 500),
			"dashboard": dashSvc.Compute(),
			"timestamp": map[string]interface{}{"now": nil}, // placeholder
		})
	}))

	// ── Dashboard API ──
	mux.HandleFunc("GET /api/dashboard", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success": true, "data": dashSvc.Compute(),
		})
	}))

	// ── Inventory API ──
	mux.HandleFunc("GET /api/inventory", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		page, _ := strconv.Atoi(q.Get("page"))
		size, _ := strconv.Atoi(q.Get("pageSize"))
		if page < 1 { page = 1 }
		if size < 1 { size = 50 }
		items := invSvc.List(q.Get("search"), page, size)
		writeJSON(w, http.StatusOK, items)
	}))

	mux.HandleFunc("POST /api/inventory/", protected(func(w http.ResponseWriter, r *http.Request) {
		stockID := strings.TrimPrefix(r.URL.Path, "/api/inventory/")
		if stockID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"success": false, "error": "stock_id required"})
			return
		}
		var updates map[string]interface{}
		json.NewDecoder(r.Body).Decode(&updates)
		if err := invSvc.UpdateAnchors(stockID, updates); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
	}))

	mux.HandleFunc("GET /api/inventory/basic", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, invSvc.BasicList())
	}))

	// Stock Balance History Report import (daily workflow — fixed columns like Python items_screen)
	mux.HandleFunc("POST /api/import-stock", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		file, _, err := r.FormFile("file")
		if err != nil { writeJSON(w, 400, map[string]interface{}{"success":false,"error":"no file"}); return }
		defer file.Close()
		counts, err := importSvc.ImportStock(file)
		if err != nil { writeJSON(w, 500, map[string]interface{}{"success":false,"error":err.Error()}); return }
		writeJSON(w, 200, map[string]interface{}{"success":true,"counts":counts})
	})))

	// ── Suppliers ──
	mux.HandleFunc("GET /suppliers", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{
			"Active": "suppliers", "ContentBlock": "content_suppliers",
			"User":   userFromReq(r),
		})
	}))

	mux.HandleFunc("GET /api/suppliers", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, supSvc.List(r.URL.Query().Get("search")))
	}))
	mux.HandleFunc("POST /api/suppliers", protected(auth.RequireRole("EDITOR", "ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Supplier     suppliers.Supplier `json:"supplier"`
			OriginalName string             `json:"original_name"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := supSvc.Save(body.Supplier, body.OriginalName); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
	})))

	mux.HandleFunc("DELETE /api/suppliers/", protected(auth.RequireRole("ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/api/suppliers/")
		if err := supSvc.Delete(name); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
	})))

	// ── Planning ──
	mux.HandleFunc("GET /planning", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{
			"Active": "planning", "ContentBlock": "content_planning",
			"User":   userFromReq(r),
		})
	}))

	mux.HandleFunc("GET /api/planning", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, planSvc.Plan())
	}))

mux.HandleFunc("POST /api/planning/order", protected(auth.RequireRole("EDITOR", "ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Items []planning.OrderItem `json:"items"`
			Notes string               `json:"notes"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		orderID, err := planSvc.MarkOrdered(body.Items, body.Notes, r.Header.Get("X-User-Email"))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "orderId": orderID})
	})))

	// ── Planning → RFQ ──
	mux.HandleFunc("POST /api/planning/rfq", protected(auth.RequireRole("EDITOR", "ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			StockIDs []string `json:"stockIds"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if len(body.StockIDs) == 0 {
			writeJSON(w, 400, map[string]interface{}{"success": false, "error": "no items selected"})
			return
		}

		// Get planning data to find items
		planned := planSvc.Plan()
		var rfqItems []rfq.Item
		var supplier string

		for _, p := range planned {
			for _, sid := range body.StockIDs {
				if p.ID == sid {
					qty := p.Suggested
					if qty <= 0 {
						qty = 1
					}
					rfqItems = append(rfqItems, rfq.Item{
						StockID: p.ID, Name: p.Name, UOM: p.UOM, Qty: qty,
					})
					if supplier == "" {
						supplier = p.Supplier
					}
					break
				}
			}
		}

		if len(rfqItems) == 0 {
			writeJSON(w, 400, map[string]interface{}{"success": false, "error": "no matching items found"})
			return
		}

		rfqDoc := rfq.RFQ{Supplier: supplier, Items: rfqItems}
		id, err := rfqSvc.Save(rfqDoc, r.Header.Get("X-User-Email"))
		if err != nil {
			writeJSON(w, 500, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"success": true, "rfq_id": id, "items": len(rfqItems)})
	})))

	// ── PO ──
	mux.HandleFunc("GET /pos", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "pos", "ContentBlock": "content_pos", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /api/pos", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		writeJSON(w, http.StatusOK, poSvc.List(q.Get("search"), q.Get("supplier"), q.Get("status"), q.Get("ship_status"), q.Get("unpaid") == "1"))
	}))
	mux.HandleFunc("GET /api/pos/next-id", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{"id": poSvc.GenerateID()})
	}))
	mux.HandleFunc("POST /api/pos", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body po.PO; json.NewDecoder(r.Body).Decode(&body)
		id, err := poSvc.Save(body)
		if err != nil { writeJSON(w, 500, map[string]interface{}{"success":false,"error":err.Error()}); return }
		for _, item := range body.Items {
			if err := uomSvc.UpsertItemMapping(body.Supplier, item.StockID, item.Name, item.SupplierUOM); err != nil {
				writeJSON(w, 500, map[string]interface{}{"success":false,"error":"PO saved but supplier UOM mapping failed: " + err.Error()})
				return
			}
		}
		writeJSON(w, 200, map[string]interface{}{"success":true,"po_id":id})
	})))
	mux.HandleFunc("POST /api/pos/{poId}/status", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Status string `json:"status"`
			Field  string `json:"field"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		col := body.Field
		if col == "" {
			col = "status"
		}
		poSvc.UpdateStatus(r.PathValue("poId"), body.Status, col)
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))

	// ── PO PDF preview & download ──
	mux.HandleFunc("GET /pos/{poId}/preview", protected(func(w http.ResponseWriter, r *http.Request) {
		po, err := poSvc.GetByID(r.PathValue("poId"))
		if err != nil {
			http.Error(w, "PO not found", 404)
			return
		}
		sup, _ := supSvc.GetByName(po.Supplier)
		items := make([]map[string]interface{}, len(po.Items))
		for i, it := range po.Items {
			items[i] = map[string]interface{}{
				"item_name": it.Name, "quantity": it.Qty,
				"cost": it.Cost, "total": it.Total,
			}
		}
		supData := map[string]string{
			"contact_person": sup.ContactPerson, "address": sup.Address,
			"phone": sup.Phone, "brn": sup.BRN,
			"bank_name": sup.BankName, "account_no": sup.AccountNo,
		}
		html := pdf.RenderPOHTML(po.POID, po.Date, po.Supplier, po.Department,
			po.Terms, po.InvoiceDate, po.Total, items, supData, logoB64, signB64)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(html))
	}))

	mux.HandleFunc("GET /pos/{poId}/pdf", protected(func(w http.ResponseWriter, r *http.Request) {
		po, err := poSvc.GetByID(r.PathValue("poId"))
		if err != nil {
			http.Error(w, "PO not found", 404)
			return
		}
		sup, _ := supSvc.GetByName(po.Supplier)
		items := make([]map[string]interface{}, len(po.Items))
		for i, it := range po.Items {
			items[i] = map[string]interface{}{
				"item_name": it.Name, "quantity": it.Qty,
				"cost": it.Cost, "total": it.Total,
			}
		}
		supData := map[string]string{
			"contact_person": sup.ContactPerson, "address": sup.Address,
			"phone": sup.Phone, "brn": sup.BRN,
			"bank_name": sup.BankName, "account_no": sup.AccountNo,
		}
		html := pdf.RenderPOHTML(po.POID, po.Date, po.Supplier, po.Department,
			po.Terms, po.InvoiceDate, po.Total, items, supData, logoB64, signB64)

		tmpDir := os.TempDir()
		tmpFile := filepath.Join(tmpDir, fmt.Sprintf("po_%s.pdf", strings.ReplaceAll(po.POID, "/", "_")))
		if err := pdf.GeneratePDF(html, tmpFile); err != nil {
			http.Error(w, "PDF generation failed: "+err.Error(), 500)
			return
		}
		defer os.Remove(tmpFile)

		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="PO_%s.pdf"`,
			strings.ReplaceAll(po.POID, "/", "_")))
		http.ServeFile(w, r, tmpFile)
	}))

	// ── RFQ ──
	mux.HandleFunc("GET /rfq", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "rfq", "ContentBlock": "content_rfq", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /api/rfq", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, rfqSvc.History())
	}))
	mux.HandleFunc("GET /api/rfq/next-id", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{"id": rfqSvc.GenerateID()})
	}))
	mux.HandleFunc("POST /api/rfq", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body rfq.RFQ; json.NewDecoder(r.Body).Decode(&body)
		id, err := rfqSvc.Save(body, r.Header.Get("X-User-Email"))
		if err != nil { writeJSON(w, 500, map[string]interface{}{"success":false,"error":err.Error()}); return }
		writeJSON(w, 200, map[string]interface{}{"success":true,"rfq_id":id})
	})))
	mux.HandleFunc("DELETE /api/rfq/{rfqId}", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		rfqSvc.Delete(r.PathValue("rfqId"))
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))

	// ── RFQ PDF preview & download ──
	mux.HandleFunc("GET /rfq/{rfqId}/preview", protected(func(w http.ResponseWriter, r *http.Request) {
		rfqDoc, err := rfqSvc.GetByID(r.PathValue("rfqId"))
		if err != nil {
			http.Error(w, "RFQ not found", 404)
			return
		}
		items := make([]map[string]interface{}, len(rfqDoc.Items))
		for i, it := range rfqDoc.Items {
			items[i] = map[string]interface{}{
				"stock_id": it.StockID, "item_name": it.Name,
				"uom": it.UOM, "qty": it.Qty,
			}
		}
		html := pdf.RenderRFQHTML(rfqDoc.RFQID, rfqDoc.Date, rfqDoc.Supplier, items, logoB64)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(html))
	}))

	mux.HandleFunc("GET /rfq/{rfqId}/pdf", protected(func(w http.ResponseWriter, r *http.Request) {
		rfqDoc, err := rfqSvc.GetByID(r.PathValue("rfqId"))
		if err != nil {
			http.Error(w, "RFQ not found", 404)
			return
		}
		items := make([]map[string]interface{}, len(rfqDoc.Items))
		for i, it := range rfqDoc.Items {
			items[i] = map[string]interface{}{
				"stock_id": it.StockID, "item_name": it.Name,
				"uom": it.UOM, "qty": it.Qty,
			}
		}
		html := pdf.RenderRFQHTML(rfqDoc.RFQID, rfqDoc.Date, rfqDoc.Supplier, items, logoB64)

		tmpDir := os.TempDir()
		tmpFile := filepath.Join(tmpDir, fmt.Sprintf("rfq_%s.pdf", strings.ReplaceAll(rfqDoc.RFQID, "/", "_")))
		if err := pdf.GeneratePDF(html, tmpFile); err != nil {
			http.Error(w, "PDF generation failed: "+err.Error(), 500)
			return
		}
		defer os.Remove(tmpFile)

		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="RFQ_%s.pdf"`,
			strings.ReplaceAll(rfqDoc.RFQID, "/", "_")))
		http.ServeFile(w, r, tmpFile)
	}))

	// ── Movement ──
	mux.HandleFunc("GET /movement", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "movement", "ContentBlock": "content_movement", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /api/movement", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		yr, _ := strconv.Atoi(q.Get("year")); mo, _ := strconv.Atoi(q.Get("month")); lim, _ := strconv.Atoi(q.Get("limit"))
		data := movSvc.List(yr, mo, q.Get("search"), lim)
		if data == nil { data = []movement.Row{} }
		writeJSON(w, http.StatusOK, data)
	}))
	mux.HandleFunc("GET /api/movement/years", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, movSvc.Years())
	}))
	mux.HandleFunc("POST /api/movement/rop", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		n := movSvc.RecalcROP()
		writeJSON(w, 200, map[string]interface{}{"success":true,"updated":n})
	})))

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
	mux.HandleFunc("POST /api/movement/bulk", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Year  int               `json:"year"`
			Month int               `json:"month"`
			Rows  []movement.BulkRow `json:"rows"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := movSvc.BulkSave(body.Year, body.Month, body.Rows); err != nil {
			writeJSON(w, 500, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"success": true, "count": len(body.Rows)})
	})))

	// ── Reports ──
	mux.HandleFunc("GET /reports", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "reports", "ContentBlock": "content_reports", "User": userFromReq(r)})
	}))

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

	// ── Validation ──
	mux.HandleFunc("GET /validation", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "validation", "ContentBlock": "content_validation", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /api/validation", protected(func(w http.ResponseWriter, r *http.Request) {
		nz := r.URL.Query().Get("nonzero") == "1"
		writeJSON(w, 200, validationSvc.Run(nz))
	}))
	mux.HandleFunc("GET /api/validation/report", protected(func(w http.ResponseWriter, r *http.Request) {
		nz := r.URL.Query().Get("nonzero") == "1"
		report := validationSvc.ReportMD(nz)
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=validation_report.md")
		w.WriteHeader(200)
		w.Write([]byte(report))
	}))

	// ── Import History ──
	mux.HandleFunc("GET /api/import/history", protected(func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.Query(`SELECT r.run_id, r.source_file, r.imported_at, r.row_counts_json
			FROM import_runs r ORDER BY r.run_id DESC LIMIT 50`)
		if rows == nil {
			writeJSON(w, 200, []interface{}{})
			return
		}
		defer rows.Close()
		type Run struct {
			RunID      int             `json:"run_id"`
			SourceFile string          `json:"source_file"`
			ImportedAt string          `json:"imported_at"`
			TableRows  json.RawMessage `json:"table_rows"`
		}
		var runs []Run
		for rows.Next() {
			var r Run
			var counts sql.NullString
			rows.Scan(&r.RunID, &r.SourceFile, &r.ImportedAt, &counts)
			if counts.Valid {
				r.TableRows = json.RawMessage(counts.String)
			}
			runs = append(runs, r)
		}
		if runs == nil { runs = []Run{} }
		writeJSON(w, 200, runs)
	}))

	// ── Extended Items API ──
	mux.HandleFunc("GET /api/inventory/filter-options", protected(func(w http.ResponseWriter, r *http.Request) {
		suppliers := supSvc.Names()
		rows, _ := db.Query("SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != '' ORDER BY category")
		var categories []string
		if rows != nil {
			defer rows.Close()
			for rows.Next() { var c string; rows.Scan(&c); categories = append(categories, c) }
		}
		if categories == nil { categories = []string{} }
		writeJSON(w, 200, map[string]interface{}{"suppliers": suppliers, "categories": categories})
	}))
	mux.HandleFunc("GET /api/inventory/detail", protected(func(w http.ResponseWriter, r *http.Request) {
		stockID := r.URL.Query().Get("stock_id")
		if stockID == "" {
			writeJSON(w, 400, map[string]interface{}{"success": false, "error": "stock_id required"})
			return
		}
		// Item detail
		var id, name, cat, ptype, supplier, uom, status, updated, beh sql.NullString
		var cost, selling, current, rop sql.NullFloat64
		var velOv sql.NullString
		db.QueryRow(`SELECT stock_id, item_name, category, product_type, supplier_name, uom,
			product_status, last_updated, item_behaviour, cost, selling_price, current_stock, rop, velocity_override
			FROM items WHERE stock_id = ?`, stockID).Scan(&id, &name, &cat, &ptype, &supplier, &uom,
			&status, &updated, &beh, &cost, &selling, &current, &rop, &velOv)

		// Supplier UOM mapping
		var supUom sql.NullString
		db.QueryRow(`SELECT supplier_uom FROM supplier_item_mappings WHERE stock_id = ? AND supplier_name = ? LIMIT 1`,
			stockID, strv(supplier)).Scan(&supUom)

		// Latest movements
		movRows, _ := db.Query(`SELECT year, month, in_qty, out_qty, adj_in, adj_out, report_closing
			FROM stock_movements WHERE stock_id = ? ORDER BY year DESC, month DESC LIMIT 5`, stockID)
		movements := []map[string]interface{}{}
		if movRows != nil {
			defer movRows.Close()
			for movRows.Next() {
				var yr, mo int
				var in, out, ai, ao, rc sql.NullFloat64
				movRows.Scan(&yr, &mo, &in, &out, &ai, &ao, &rc)
				movements = append(movements, map[string]interface{}{
					"year": yr, "month": mo, "in_qty": f64v(in), "out_qty": f64v(out),
					"adj_in": f64v(ai), "adj_out": f64v(ao), "closing": f64v(rc),
				})
			}
		}

		// PO history
		poRows, _ := db.Query(`SELECT poi.po_id, po.date, po.supplier, poi.quantity, poi.cost, poi.total
			FROM purchase_order_items poi JOIN purchase_orders po ON po.po_id = poi.po_id
			WHERE LOWER(poi.stock_id) = LOWER(?) OR LOWER(poi.item_name) = LOWER(?)
			ORDER BY po.date DESC LIMIT 10`, stockID, strv(name))
		poHistory := []map[string]interface{}{}
		if poRows != nil {
			defer poRows.Close()
			for poRows.Next() {
				var poID, date, sup sql.NullString
				var qty, cst, tot sql.NullFloat64
				poRows.Scan(&poID, &date, &sup, &qty, &cst, &tot)
				poHistory = append(poHistory, map[string]interface{}{
					"po_id": strv(poID), "date": strv(date), "supplier": strv(sup),
					"qty": f64v(qty), "cost": f64v(cst), "total": f64v(tot),
				})
			}
		}

		writeJSON(w, 200, map[string]interface{}{
			"stock_id": strv(id), "item_name": strv(name), "category": strv(cat),
			"product_type": strv(ptype), "supplier_name": strv(supplier), "uom": strv(uom),
			"product_status": strv(status), "last_updated": strv(updated),
			"item_behaviour": strv(beh), "cost": f64v(cost), "selling_price": f64v(selling),
			"current_stock": f64v(current), "rop": f64v(rop), "velocity_override": strv(velOv),
			"supplier_uom": strv(supUom),
			"movements": movements, "po_history": poHistory,
		})
	}))
	mux.HandleFunc("GET /api/reports/restock", protected(func(w http.ResponseWriter, r *http.Request) {
		p, _ := strconv.Atoi(r.URL.Query().Get("page")); sz, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
		writeJSON(w, 200, repSvc.RestockReport(p, sz))
	}))
	mux.HandleFunc("GET /api/reports/historical", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		yr, _ := strconv.Atoi(q.Get("year")); mo, _ := strconv.Atoi(q.Get("month"))
		p, _ := strconv.Atoi(q.Get("page")); sz, _ := strconv.Atoi(q.Get("pageSize"))
		writeJSON(w, 200, repSvc.HistoricalReport(q.Get("type"), yr, mo, p, sz))
	}))
	mux.HandleFunc("GET /api/reports/search-po-items", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if q == "" {
			writeJSON(w, 200, []interface{}{})
			return
		}
		term := "%" + strings.ToLower(q) + "%"
		rows, _ := db.Query(`
			SELECT DISTINCT poi.stock_id, COALESCE(poi.item_name, '')
			FROM purchase_order_items poi
			WHERE LOWER(COALESCE(poi.item_name,'')) LIKE ?
			   OR LOWER(COALESCE(poi.stock_id,'')) LIKE ?
			ORDER BY poi.item_name
			LIMIT 50
		`, term, term)
		if rows == nil {
			writeJSON(w, 200, []interface{}{})
			return
		}
		defer rows.Close()
		var items []map[string]string
		for rows.Next() {
			var id, name string
			rows.Scan(&id, &name)
			items = append(items, map[string]string{"stock_id": id, "item_name": name})
		}
		if items == nil { items = []map[string]string{} }
		writeJSON(w, 200, items)
	}))
	mux.HandleFunc("POST /api/reports/item-history", protected(func(w http.ResponseWriter, r *http.Request) {
		var body []struct{ID string `json:"id"`; Name string `json:"name"`}
		json.NewDecoder(r.Body).Decode(&body)
		// Convert to the type expected by report service
		items := make([]struct{ID string; Name string}, len(body))
		for i, b := range body { items[i].ID = b.ID; items[i].Name = b.Name }
		writeJSON(w, 200, repSvc.ItemHistory(items))
	}))

	// ── Tasks ──
	mux.HandleFunc("GET /api/tasks", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, taskSvc.List())
	}))
	mux.HandleFunc("POST /api/tasks", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body tasks.Task; json.NewDecoder(r.Body).Decode(&body)
		taskSvc.Save(body)
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))

	// ── Scorecard ──
	mux.HandleFunc("GET /api/scorecard", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, scoreSvc.List())
	}))
	mux.HandleFunc("GET /api/scorecard/summary", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, scoreSvc.Summary())
	}))
	mux.HandleFunc("POST /api/scorecard", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body scorecard.Entry; json.NewDecoder(r.Body).Decode(&body)
		scoreSvc.Save(body)
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))

	// ── Workflow ──
	mux.HandleFunc("POST /api/workflow/approve", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct{POID string `json:"po_id"`}; json.NewDecoder(r.Body).Decode(&body)
		wfSvc.Approve(body.POID)
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))
	mux.HandleFunc("POST /api/workflow/payment", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct{POID string `json:"po_id"`}; json.NewDecoder(r.Body).Decode(&body)
		wfSvc.RequestPayment(body.POID)
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))
	mux.HandleFunc("GET /api/workflow/pending", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, wfSvc.PendingActions())
	}))

	// ── Analytics ──
	mux.HandleFunc("GET /api/analytics", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		fy,_:=strconv.Atoi(q.Get("from_year")); fm,_:=strconv.Atoi(q.Get("from_month"))
		ty,_:=strconv.Atoi(q.Get("to_year")); tm,_:=strconv.Atoi(q.Get("to_month"))
		if fy==0 { fy=2025 }; if ty==0 { ty=time.Now().Year(); tm=int(time.Now().Month())-1 }
		writeJSON(w, 200, analyticsSvc.Compute(fy,fm,ty,tm))
	}))
	mux.HandleFunc("POST /api/analytics/freeze", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		y,_:=strconv.Atoi(q.Get("year")); mo,_:=strconv.Atoi(q.Get("month"))
		if y==0 { y=time.Now().Year(); mo=int(time.Now().Month())-1 }
		vals, err := analyticsSvc.Freeze(y, mo)
		if err != nil { writeJSON(w, 500, map[string]string{"error": err.Error()}); return }
		writeJSON(w, 200, vals)
	}))
	mux.HandleFunc("GET /api/analytics/export", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		fy,_:=strconv.Atoi(q.Get("from_year")); fm,_:=strconv.Atoi(q.Get("from_month"))
		ty,_:=strconv.Atoi(q.Get("to_year")); tm,_:=strconv.Atoi(q.Get("to_month"))
		if fy==0 { fy=2025 }; if ty==0 { ty=time.Now().Year(); tm=int(time.Now().Month())-1 }
		b, err := analyticsSvc.Export(fy,fm,ty,tm)
		if err != nil { writeJSON(w, 500, map[string]string{"error": err.Error()}); return }
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		w.Header().Set("Content-Disposition", `attachment; filename="procura-analytics.xlsx"`)
		w.Write(b)
	}))

	// ── Catalogue ──
	mux.HandleFunc("GET /api/catalogue", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query(); lim,_:=strconv.Atoi(q.Get("limit"))
		writeJSON(w, 200, catalogueSvc.Items(q.Get("search"), q.Get("supplier"), lim))
	}))
	mux.HandleFunc("GET /api/catalogue/sources", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, catalogueSvc.Sources())
	}))

	// ── UOM ──
	mux.HandleFunc("GET /api/uom/mappings", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, uomSvc.Mappings(r.URL.Query().Get("supplier")))
	}))
	mux.HandleFunc("GET /api/uom", protected(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, uomSvc.UOMs(r.URL.Query().Get("supplier")))
	}))
	mux.HandleFunc("POST /api/uom/mapping", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body uom.Mapping; json.NewDecoder(r.Body).Decode(&body); uomSvc.SaveMapping(body)
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))

	// ── Import ──
	mux.HandleFunc("POST /api/import", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		file, hdr, err := r.FormFile("file")
		if err != nil { writeJSON(w, 400, map[string]interface{}{"success":false,"error":"no file"}); return }
		defer file.Close()
		movYear, _ := strconv.Atoi(r.FormValue("movement_year"))
		movMonth, _ := strconv.Atoi(r.FormValue("movement_month"))
		if movYear > 0 && movMonth >= 1 && movMonth <= 12 {
			// Standalone monthly movement report → use bulk endpoint logic
			count, err := importSvc.ImportMovements(file, hdr.Filename, movYear, movMonth)
			if err != nil { writeJSON(w, 500, map[string]interface{}{"success":false,"error":err.Error()}); return }
			writeJSON(w, 200, map[string]interface{}{"success":true,"rows":count,"tables":1})
			return
		}
		result, err := importSvc.Import(file, hdr.Filename)
		if err != nil { writeJSON(w, 500, map[string]interface{}{"success":false,"error":err.Error()}); return }
		writeJSON(w, 200, map[string]interface{}{"success":true,"run_id":result.RunID,"tables":len(result.TableRows),"rows":result.Rows,"sheets_found":result.SheetsFound,"headers_found":result.HeadersFound})
	})))

	// ── Change PIN ──
	mux.HandleFunc("POST /api/change-pin", protected(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			OldPin string `json:"oldPin"`
			NewPin string `json:"newPin"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := authSvc.ChangePIN(r.Header.Get("X-User-Email"), body.OldPin, body.NewPin); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
	}))

	log.Println("procura listening on :8082")
	http.ListenAndServe(":8082", mux)
}

func userFromReq(r *http.Request) map[string]string {
	return map[string]string{
		"email": r.Header.Get("X-User-Email"),
		"role":  r.Header.Get("X-User-Role"),
		"name":  r.Header.Get("X-User-Name"),
	}
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func f64v(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
