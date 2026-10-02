package core

import (
	"database/sql"
	"fmt"
)

// PendingUOM names an item whose imported unit needs explicit confirmation.
func PendingUOM(db *sql.DB, stockID string) (string, error) {
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

func CheckPendingUOM(db *sql.DB, stockID string) error {
	name, err := PendingUOM(db, stockID)
	if err != nil {
		return err
	}
	if name != "" {
		return fmt.Errorf("%s (%s) has a pending UOM change; use Confirm UOM in the item editor", name, stockID)
	}
	return nil
}
