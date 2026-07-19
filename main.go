package main

import (
	"embed"
	"encoding/json"
	"html/template"
	"io/fs"
	"log"
	"net/http"
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
	"procura/internal/planning"
	"procura/internal/po"
	"procura/internal/report"
	"procura/internal/rfq"
	"procura/internal/scorecard"
	"procura/internal/suppliers"
	"procura/internal/tasks"
	"procura/internal/uom"
	"procura/internal/workflow"
)

//go:embed templates static
var assets embed.FS

func main() {
	db, err := core.Open("data")
	if err != nil {
		log.Fatal(err)
	}

	authSvc := &auth.Service{DB: db}
	authSvc.CreateTestUser()

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

	// ── Protected pages ──
	protected := authSvc.Middleware

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
		writeJSON(w, 200, map[string]interface{}{"success":true,"po_id":id})
	})))
	mux.HandleFunc("POST /api/pos/{poId}/status", protected(auth.RequireRole("EDITOR","ADMIN")(func(w http.ResponseWriter, r *http.Request) {
		var body struct{Status string `json:"status"`}; json.NewDecoder(r.Body).Decode(&body)
		poSvc.UpdateStatus(r.PathValue("poId"), body.Status, "status")
		writeJSON(w, 200, map[string]interface{}{"success":true})
	})))

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

	// ── Movement ──
	mux.HandleFunc("GET /movement", protected(func(w http.ResponseWriter, r *http.Request) {
		tmpl.ExecuteTemplate(w, "base.html", map[string]interface{}{"Active": "movement", "ContentBlock": "content_movement", "User": userFromReq(r)})
	}))
	mux.HandleFunc("GET /api/movement", protected(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		yr, _ := strconv.Atoi(q.Get("year")); mo, _ := strconv.Atoi(q.Get("month")); lim, _ := strconv.Atoi(q.Get("limit"))
		writeJSON(w, http.StatusOK, movSvc.List(yr, mo, q.Get("search"), lim))
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
		result, err := importSvc.Import(file, hdr.Filename)
		if err != nil { writeJSON(w, 500, map[string]interface{}{"success":false,"error":err.Error()}); return }
		writeJSON(w, 200, map[string]interface{}{"success":true,"run_id":result.RunID,"tables":len(result.TableRows),"rows":result.Rows})
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
