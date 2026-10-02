package core

import (
	"database/sql"
	"fmt"
)

// NextDocumentID locks the writer before reading the sequence. Callers supply
// fixed table/column names and insert without upsert in this same transaction.
func NextDocumentID(tx *sql.Tx, table, column, prefix string, width int) (string, error) {
	// An empty UPDATE acquires SQLite's write lock without changing any row.
	if _, err := tx.Exec("UPDATE " + table + " SET " + column + "=" + column + " WHERE 0"); err != nil {
		return "", err
	}
	var sequence int
	if err := tx.QueryRow("SELECT COALESCE(MAX(CAST(SUBSTR("+column+", ?) AS INTEGER)),0) FROM "+table+" WHERE "+column+" LIKE ?",
		len(prefix)+1, prefix+"%").Scan(&sequence); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%0*d", prefix, width, sequence+1), nil
}
