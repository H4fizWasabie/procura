package core

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

var ErrPendingUOM = errors.New("pending UOM change")
var ErrInvalidPackUOM = errors.New("unit is not in the list")

// RowQuerier lets guards use either the pool or a document's transaction.
type RowQuerier interface {
	QueryRow(string, ...interface{}) *sql.Row
}

// PendingUOM names an item whose imported unit needs explicit confirmation.
func PendingUOM(db RowQuerier, stockID string) (string, error) {
	if stockID == "" {
		return "", nil
	}
	var name string
	err := db.QueryRow(`SELECT COALESCE(item_name, stock_id) FROM items
		WHERE stock_id = ? AND uom_confirmation_pending = 1`, stockID).Scan(&name)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return name, err
}

func CheckPendingUOM(db RowQuerier, stockID string) error {
	name, err := PendingUOM(db, stockID)
	if err != nil {
		return err
	}
	if name != "" {
		return fmt.Errorf("%s (%s) has a %w; use Confirm UOM in the item editor", name, stockID, ErrPendingUOM)
	}
	return nil
}

// PackUOMs is the fixed unit list for item pack sizes and PO supplier units.
var PackUOMs = []string{"pcs", "unit", "box", "pack", "bag", "bottle", "carton", "roll", "tube", "can", "jar", "vial", "pouch", "drum", "gallon"}

// NormalizePackUOM returns the listed unit matching s, ignoring case and spaces.
func NormalizePackUOM(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	for _, u := range PackUOMs {
		if s == u {
			return u, true
		}
	}
	return "", false
}
