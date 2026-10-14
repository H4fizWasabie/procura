package po

import (
	"strings"
	"testing"

	"procura/internal/core"
)

func TestPackSizeStaysOnItsPOLine(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name) VALUES('A','Capsules')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	save := func(date, supplier string, qty float64, uom string) (string, error) {
		return s.Save(PO{Date: date, Supplier: supplier, Department: "Ward",
			Items: []Item{{StockID: "A", Name: "Capsules", Qty: 1, PackQty: qty, PackUOM: uom}}})
	}
	if _, err := save("2026-10-01", "Alpha", 500, " Bottle "); err != nil {
		t.Fatal(err)
	}
	if _, err := save("2026-10-05", "Beta", 100, "box"); err != nil {
		t.Fatal(err)
	}
	if _, err := save("2026-10-03", "Alpha", 250, "bottle"); err != nil {
		t.Fatal(err)
	}
	voided, err := save("2026-10-09", "Alpha", 1, "pcs")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Void(voided); err != nil {
		t.Fatal(err)
	}
	if _, err := save("2026-10-10", "Alpha", 5, "crate"); err == nil {
		t.Fatal("unlisted pack unit saved")
	}
	if _, err := save("2026-10-10", "Alpha", 5, ""); err == nil {
		t.Fatal("pack quantity without unit saved")
	}

	packs, err := s.LinePacks()
	if err != nil {
		t.Fatal(err)
	}
	latest := map[string]string{}
	for _, p := range packs {
		latest[p.Supplier] = packSize(Item{PackQty: p.PackQty, PackUOM: p.PackUOM})
	}
	if latest["Alpha"] != "250/bottle" || latest["Beta"] != "100/box" || len(packs) != 3 {
		t.Fatalf("latest packs %v from %+v", latest, packs)
	}
	var raw, packSizeText string
	db.QueryRow(`SELECT o.raw_po_json, i.pack_size FROM purchase_orders o JOIN purchase_order_items i ON i.po_id=o.po_id WHERE o.supplier='Beta'`).Scan(&raw, &packSizeText)
	if strings.Contains(raw, "pack") || packSizeText != "100/box" {
		t.Fatalf("raw_po_json %s, pack_size %q", raw, packSizeText)
	}
	var itemPack any
	db.QueryRow(`SELECT pack_qty FROM items WHERE stock_id='A'`).Scan(&itemPack)
	if itemPack != nil {
		t.Fatalf("PO save changed the item pack: %v", itemPack)
	}
}
