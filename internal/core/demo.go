package core

import (
	"database/sql"
	"encoding/json"
)

// SeedDemo creates a small, fictional workspace. It is idempotent so restarts
// never duplicate rows or change the real database.
func SeedDemo(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS supplier_uom (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT, supplier_uom TEXT, standard_uom TEXT)`,
		`CREATE TABLE IF NOT EXISTS supplier_item_mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT, supplier_item_name TEXT, supplier_uom TEXT, stock_id TEXT, brand TEXT, match_priority INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1)`,
		`CREATE TABLE IF NOT EXISTS item_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, canonical_item_name TEXT, canonical_stock_id TEXT, alias_item_name TEXT, created_at TEXT, created_by TEXT, is_active INTEGER DEFAULT 1)`,
		`CREATE TABLE IF NOT EXISTS catalogue_items (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT, supplier_item_code TEXT, supplier_item_name TEXT, normalized_item_name TEXT, brand TEXT, pack TEXT, uom TEXT, indicative_price REAL, currency TEXT, freshness_status TEXT, is_active INTEGER DEFAULT 1)`,
		`CREATE TABLE IF NOT EXISTS catalogue_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, catalogue_item_id INTEGER, rule_type TEXT, trigger_qty REAL, paid_qty REAL, free_qty REAL, tier_price REAL, bonus_price REAL, effective_unit_price REAL, free_text_rule TEXT, is_active INTEGER DEFAULT 1)`,
		`CREATE TABLE IF NOT EXISTS catalogue_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT, source_type TEXT, source_as_of TEXT, freshness_status TEXT, is_active INTEGER DEFAULT 1)`,
	} {
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}

	var seeded string
	if err := tx.QueryRow("SELECT value FROM settings WHERE key = 'demo_seed_version'").Scan(&seeded); err == nil && seeded != "" {
		return tx.Commit()
	}

	for _, s := range []struct {
		id, name, category, productType, supplier, uom, behaviour string
		current, rop, cost, price, velocity, target               float64
	}{
		{"DEMO-001", "Nitrile Examination Gloves", "Clinical supplies", "consumable", "Northstar Medical", "box", "Standard / Pack", 96, 240, 18.50, 29.90, 82, 0},
		{"DEMO-002", "Sterile Syringes 5ml", "Clinical supplies", "consumable", "Northstar Medical", "box", "Standard / Pack", 38, 120, 22.00, 34.50, 44, 0},
		{"DEMO-003", "Thermal Receipt Rolls", "Office supplies", "consumable", "Harbor Office Goods", "pack", "Standard / Pack", 75, 60, 9.80, 15.00, 18, 0},
		{"DEMO-004", "Printer Toner Black", "Office supplies", "consumable", "Harbor Office Goods", "unit", "Standard / Pack", 9, 12, 145.00, 210.00, 4, 0},
		{"DEMO-005", "Hand Sanitiser 500ml", "Facilities", "consumable", "Mango Grove Distribution", "bottle", "In-House Use", 24, 80, 7.40, 11.90, 30, 0},
		{"DEMO-006", "Barcode Label Roll", "Warehouse", "consumable", "Mango Grove Distribution", "roll", "Standard / Pack", 12, 36, 12.50, 19.00, 16, 0},
		{"DEMO-007", "Reusable Storage Bin", "Warehouse", "asset", "Harbor Office Goods", "unit", "Standard / Pack", 44, 20, 28.00, 45.00, 6, 0},
		{"DEMO-008", "Temperature Log Sheet", "Compliance", "consumable", "Northstar Medical", "pack", "Standard / Pack", 18, 25, 6.20, 10.00, 8, 30},
	} {
		if _, err := tx.Exec(`INSERT INTO items
			(stock_id,item_name,cost,uom,product_type,category,current_stock,rop,selling_price,last_updated,pack_size,exclude,product_status,supplier_name,item_behaviour,velocity,initial_stock_target)
			VALUES (?,?,?,?,?,?,?,?,?,'2026-09-01','',0,'Available',?,?,?,?)`,
			s.id, s.name, s.cost, s.uom, s.productType, s.category, s.current, s.rop, s.price, s.supplier, s.behaviour, s.velocity, s.target); err != nil {
			return err
		}
	}

	for _, s := range []struct {
		name, contact, phone, email, address, terms string
	}{
		{"Northstar Medical", "Avery Tan", "+60 3 5550 1001", "orders@northstar.example", "12 Meridian Park", "30 days"},
		{"Harbor Office Goods", "Mira Lee", "+60 3 5550 1002", "sales@harbor.example", "8 Dockside Avenue", "14 days"},
		{"Mango Grove Distribution", "Jordan Lim", "+60 3 5550 1003", "hello@mango-grove.example", "21 Orchard Lane", "Cash on delivery"},
	} {
		if _, err := tx.Exec(`INSERT INTO suppliers (supplier_name,contact_person,phone,email,address,payment_terms) VALUES (?,?,?,?,?,?)`, s.name, s.contact, s.phone, s.email, s.address, s.terms); err != nil {
			return err
		}
	}

	poItems := map[string][]map[string]interface{}{
		"PO-DEMO-001": {{"id": "DEMO-001", "stock_id": "DEMO-001", "item_name": "Nitrile Examination Gloves", "quantity": 120, "cost": 18.5, "total": 2220, "uom": "box"}},
		"PO-DEMO-002": {{"id": "DEMO-002", "stock_id": "DEMO-002", "item_name": "Sterile Syringes 5ml", "quantity": 80, "cost": 22, "total": 1760, "uom": "box"}},
		"PO-DEMO-003": {{"id": "DEMO-005", "stock_id": "DEMO-005", "item_name": "Hand Sanitiser 500ml", "quantity": 60, "cost": 7.4, "total": 444, "uom": "bottle"}},
	}
	for _, p := range []struct {
		id, date, supplier, bill, status, ship, dept, terms string
		total, paid, balance                                float64
	}{
		{"PO-DEMO-001", "2026-09-02", "Northstar Medical", "INV-DEMO-001", "Pending Approval", "Pending", "Clinic", "30 days", 2220, 0, 2220},
		{"PO-DEMO-002", "2026-08-25", "Northstar Medical", "INV-DEMO-002", "Pending Payment", "Pending", "Clinic", "30 days", 1760, 0, 1760},
		{"PO-DEMO-003", "2026-07-18", "Mango Grove Distribution", "INV-DEMO-003", "PAID", "Received", "Facilities", "Cash on delivery", 444, 444, 0},
	} {
		raw, _ := json.Marshal(poItems[p.id])
		if _, err := tx.Exec(`INSERT INTO purchase_orders (po_id,date,supplier,bill_no,total,paid,balance,status,ship_status,department,terms,raw_po_json,linked_rfq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, p.id, p.date, p.supplier, p.bill, p.total, p.paid, p.balance, p.status, p.ship, p.dept, p.terms, string(raw), ""); err != nil {
			return err
		}
		for _, it := range poItems[p.id] {
			if _, err := tx.Exec(`INSERT INTO purchase_order_items (po_id,item_name,quantity,cost,total,uom,stock_id,supplier_uom) VALUES (?,?,?,?,?,?,?,?)`, p.id, it["item_name"], it["quantity"], it["cost"], it["total"], it["uom"], it["stock_id"], it["uom"]); err != nil {
				return err
			}
		}
	}

	for _, o := range []struct {
		id, date, stock, name, supplier, status, notes string
		qty                                            float64
	}{
		{"DO-DEMO-001", "2026-09-03", "DEMO-004", "Printer Toner Black", "Harbor Office Goods", "ACTIVE", "Urgent replenishment", 6},
		{"DO-DEMO-002", "2026-08-20", "DEMO-006", "Barcode Label Roll", "Mango Grove Distribution", "DELIVERED", "Delivered to warehouse", 24},
	} {
		if _, err := tx.Exec(`INSERT INTO direct_orders (order_id,date,stock_id,item_name,supplier,quantity,ordered_by,notes,status) VALUES (?,?,?,?,?,?,?, ?,?)`, o.id, o.date, o.stock, o.name, o.supplier, o.qty, "demo@procura.app", o.notes, o.status); err != nil {
			return err
		}
	}

	for _, r := range []struct {
		id, date, supplier              string
		quality, accuracy, speed, score float64
	}{
		{"PO-DEMO-003", "2026-08-01", "Mango Grove Distribution", 4.8, 4.6, 4.7, 4.7},
		{"PO-DEMO-002", "2026-08-29", "Northstar Medical", 4.2, 4.5, 3.9, 4.2},
		{"PO-DEMO-001", "2026-09-04", "Harbor Office Goods", 4.5, 4.1, 4.4, 4.3},
	} {
		if _, err := tx.Exec(`INSERT INTO supplier_performance (timestamp,po_id,supplier_name,rated_by,quality,accuracy,speed,weighted_score,comments) VALUES (?,?,?,?,?,?,?,?,?)`, r.date, r.id, r.supplier, "Demo User", r.quality, r.accuracy, r.speed, r.score, "Sample review"); err != nil {
			return err
		}
	}
	for _, t := range []struct{ id, title, notes, status, date string }{
		{"TK-DEMO-001", "Review low stock alerts", "Check gloves and syringe replenishment.", "OPEN", "2026-09-05"},
		{"TK-DEMO-002", "Confirm toner delivery", "Follow up with Harbor Office Goods.", "IN PROGRESS", "2026-09-04"},
		{"TK-DEMO-003", "Archive August invoices", "Monthly close checklist.", "DONE", "2026-08-31"},
	} {
		if _, err := tx.Exec(`INSERT INTO tasks (task_id,title,notes,status,created_by,created_date) VALUES (?,?,?,?,?,?)`, t.id, t.title, t.notes, t.status, "Demo User", t.date); err != nil {
			return err
		}
	}

	for _, u := range []struct{ supplier, supplierUOM, standard string }{
		{"Northstar Medical", "box", "BOX"},
		{"Harbor Office Goods", "unit", "UNIT"},
		{"Mango Grove Distribution", "bottle", "BOTTLE"},
	} {
		if _, err := tx.Exec(`INSERT INTO supplier_uom (supplier_name,supplier_uom,standard_uom) VALUES (?,?,?)`, u.supplier, u.supplierUOM, u.standard); err != nil {
			return err
		}
	}
	for _, m := range []struct{ supplier, name, uom, stock, brand string }{
		{"Northstar Medical", "Nitrile Examination Gloves", "box", "DEMO-001", "Northstar"},
		{"Northstar Medical", "Sterile Syringes 5ml", "box", "DEMO-002", "Northstar"},
		{"Harbor Office Goods", "Printer Toner Black", "unit", "DEMO-004", "Harbor"},
		{"Mango Grove Distribution", "Hand Sanitiser 500ml", "bottle", "DEMO-005", "Mango Grove"},
	} {
		if _, err := tx.Exec(`INSERT INTO supplier_item_mappings (supplier_name,supplier_item_name,supplier_uom,stock_id,brand) VALUES (?,?,?,?,?)`, m.supplier, m.name, m.uom, m.stock, m.brand); err != nil {
			return err
		}
	}

	for _, c := range []struct {
		supplier, code, name, brand, pack, uom string
		price                                  float64
	}{
		{"Northstar Medical", "NS-GLV-100", "Nitrile Examination Gloves", "Northstar", "100 per box", "box", 18.5},
		{"Harbor Office Goods", "HO-TONER-B", "Printer Toner Black", "Harbor", "1 unit", "unit", 145},
		{"Mango Grove Distribution", "MG-SAN-500", "Hand Sanitiser 500ml", "Mango Grove", "500ml bottle", "bottle", 7.4},
	} {
		res, err := tx.Exec(`INSERT INTO catalogue_items (supplier_name,supplier_item_code,supplier_item_name,normalized_item_name,brand,pack,uom,indicative_price,currency,freshness_status) VALUES (?,?,?,?,?,?,?,?,?,?)`, c.supplier, c.code, c.name, c.name, c.brand, c.pack, c.uom, c.price, "MYR", "current")
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		if c.code == "NS-GLV-100" {
			if _, err := tx.Exec(`INSERT INTO catalogue_deals (catalogue_item_id,rule_type,trigger_qty,paid_qty,free_qty,effective_unit_price,free_text_rule) VALUES (?,?,?,?,?,?,?)`, id, "BONUS", 10, 10, 1, 16.82, "Buy 10 boxes, get 1 free"); err != nil {
				return err
			}
		}
	}
	for _, s := range []struct{ supplier, kind, asOf string }{
		{"Northstar Medical", "Supplier catalogue", "2026-09-01"},
		{"Harbor Office Goods", "Supplier catalogue", "2026-08-28"},
		{"Mango Grove Distribution", "Supplier catalogue", "2026-09-02"},
	} {
		if _, err := tx.Exec(`INSERT INTO catalogue_sources (supplier_name,source_type,source_as_of,freshness_status) VALUES (?,?,?,?)`, s.supplier, s.kind, s.asOf, "current"); err != nil {
			return err
		}
	}

	for month := 1; month <= 8; month++ {
		for _, item := range []struct {
			id, name         string
			in, out, closing float64
		}{
			{"DEMO-001", "Nitrile Examination Gloves", 110, 72 + float64(month%3)*8, 150 - float64(month*7)},
			{"DEMO-002", "Sterile Syringes 5ml", 70, 38 + float64(month%2)*5, 92 - float64(month*5)},
			{"DEMO-003", "Thermal Receipt Rolls", 80, 16 + float64(month%3)*3, 82 - float64(month)},
			{"DEMO-004", "Printer Toner Black", 12, 3 + float64(month%2), 14 - float64(month%2)},
			{"DEMO-005", "Hand Sanitiser 500ml", 45, 24 + float64(month%2)*4, 42 - float64(month*2)},
			{"DEMO-006", "Barcode Label Roll", 30, 12 + float64(month%3), 28 - float64(month)},
			{"DEMO-007", "Reusable Storage Bin", 10, 5, 44},
			{"DEMO-008", "Temperature Log Sheet", 25, 7 + float64(month%2), 22},
		} {
			if _, err := tx.Exec(`INSERT INTO stock_movements (stock_id,item_name,year,month,in_qty,out_qty,adj_in,adj_out,report_closing) VALUES (?,?,?,?,?,?,?,?,?)`, item.id, item.name, 2026, month, item.in, item.out, 0, 0, item.closing); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(`INSERT INTO rfq_logs (rfq_id,date,supplier,items_count,created_by,raw_rfq_json) VALUES (?,?,?,?,?,?)`, "RFQ-DEMO-001", "2026-09-01", "Northstar Medical", 1, "Demo User", `[ {"id":"DEMO-001","n":"Nitrile Examination Gloves","u":"box","q":"80"} ]`); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO settings (key,value) VALUES ('demo_seed_version','1')"); err != nil {
		return err
	}
	return tx.Commit()
}
