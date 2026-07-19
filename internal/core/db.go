package core

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

var schema = []string{
	`CREATE TABLE IF NOT EXISTS users (
		email TEXT PRIMARY KEY,
		role TEXT NOT NULL DEFAULT 'VIEWER',
		name TEXT NOT NULL,
		department TEXT,
		pin_hash TEXT NOT NULL,
		must_change_pin INTEGER NOT NULL DEFAULT 0,
		last_access TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		user_email TEXT,
		action TEXT,
		module TEXT,
		context TEXT,
		details TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS items (
		stock_id TEXT PRIMARY KEY,
		item_name TEXT,
		cost REAL,
		uom TEXT,
		product_type TEXT,
		category TEXT,
		current_stock REAL,
		rop REAL,
		selling_price REAL,
		last_updated TEXT,
		pack_size TEXT,
		exclude INTEGER,
		product_status TEXT,
		velocity_override TEXT,
		supplier_name TEXT,
		item_behaviour TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS suppliers (
		supplier_name TEXT PRIMARY KEY,
		contact_person TEXT,
		phone TEXT,
		email TEXT,
		address TEXT,
		payment_terms TEXT,
		brn TEXT,
		account_no TEXT,
		bank_name TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS purchase_orders (
		po_id TEXT PRIMARY KEY,
		date TEXT,
		supplier TEXT,
		bill_no TEXT,
		total REAL,
		paid REAL,
		balance REAL,
		status TEXT,
		ship_status TEXT,
		quotation_url TEXT,
		invoice_url TEXT,
		department TEXT,
		terms TEXT,
		signed_url TEXT,
		linked_rfq TEXT,
		payment_url TEXT,
		item_history_url TEXT,
		raw_po_json TEXT,
		invoice_date TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS purchase_order_items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		po_id TEXT NOT NULL,
		item_name TEXT,
		quantity REAL,
		cost REAL,
		total REAL,
		uom TEXT,
		stock_id TEXT,
		pack_size TEXT,
		supplier_uom TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS stock_movements (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		stock_id TEXT,
		item_name TEXT,
		year INTEGER,
		month INTEGER,
		in_qty REAL,
		out_qty REAL,
		adj_in REAL,
		adj_out REAL,
		report_closing REAL
	)`,
	`CREATE TABLE IF NOT EXISTS movement_edit_audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		stock_id TEXT,
		item_name TEXT,
		year INTEGER,
		month INTEGER,
		field_name TEXT,
		old_value TEXT,
		new_value TEXT,
		reason TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS item_anchor_audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		stock_id TEXT,
		item_name TEXT,
		field_name TEXT,
		old_value TEXT,
		new_value TEXT,
		reason TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS rfq_logs (
		rfq_id TEXT PRIMARY KEY,
		date TEXT,
		supplier TEXT,
		items_count INTEGER,
		created_by TEXT,
		signed_url TEXT,
		raw_rfq_json TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS direct_orders (
		order_id TEXT PRIMARY KEY,
		date TEXT,
		stock_id TEXT,
		item_name TEXT,
		supplier TEXT,
		quantity REAL,
		ordered_by TEXT,
		notes TEXT,
		status TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS supplier_performance (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT,
		po_id TEXT,
		supplier_name TEXT,
		rated_by TEXT,
		quality REAL,
		accuracy REAL,
		speed REAL,
		weighted_score REAL,
		comments TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS tasks (
		task_id TEXT PRIMARY KEY,
		title TEXT,
		notes TEXT,
		attachments TEXT,
		status TEXT,
		created_by TEXT,
		created_date TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS invoices (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		invoice_no TEXT,
		invoice_date TEXT,
		supplier TEXT,
		po_no TEXT,
		po_date TEXT,
		do_no TEXT,
		do_date TEXT,
		department TEXT,
		date_received TEXT,
		total_amount REAL,
		doc_url TEXT,
		timestamp TEXT,
		raw_invoice_json TEXT,
		source_sheet TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS incoming_docs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		date_uploaded TEXT,
		doc_type TEXT,
		ref_no TEXT,
		supplier TEXT,
		eta_date TEXT,
		file_url TEXT,
		status TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS order_review (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		date TEXT,
		sku TEXT,
		name TEXT,
		supplier TEXT,
		uom TEXT,
		cost REAL,
		actual_stock REAL,
		rop REAL,
		status TEXT,
		category TEXT,
		department TEXT,
		snooze_until TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS import_runs (
		run_id INTEGER PRIMARY KEY AUTOINCREMENT,
		source_file TEXT NOT NULL,
		copied_file TEXT NOT NULL,
		imported_at TEXT NOT NULL,
		row_counts_json TEXT,
		warnings TEXT,
		errors TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS import_run_tables (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id INTEGER NOT NULL,
		table_name TEXT NOT NULL,
		rows_imported INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT
	)`,
}

func Open(dataDir string) (*sql.DB, error) {
	os.MkdirAll(dataDir, 0755)
	path := filepath.Join(dataDir, "procura.sqlite")
	db, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite serialized mode
	for _, s := range schema {
		if _, err := db.Exec(s); err != nil {
			return nil, err
		}
	}
	log.Printf("core: database ready at %s", path)
	return db, nil
}
