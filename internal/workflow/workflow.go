package workflow

import "database/sql"

type Service struct{ DB *sql.DB }

// Approve moves a PO from "Pending Approval" to "Approved".
func (s *Service) Approve(poID string) error {
	_, err := s.DB.Exec(`
		UPDATE purchase_orders SET status = 'Approved' WHERE po_id = ? AND status = 'Pending Approval'
	`, poID)
	return err
}

// RequestPayment moves from "Approved" to "Pending Payment".
func (s *Service) RequestPayment(poID string) error {
	_, err := s.DB.Exec(`
		UPDATE purchase_orders SET status = 'Pending Payment' WHERE po_id = ? AND status = 'Approved'
	`, poID)
	return err
}

// MarkPaid sets PO status to "Paid" and sets paid amount.
func (s *Service) MarkPaid(poID string, amount float64) error {
	_, err := s.DB.Exec(`
		UPDATE purchase_orders SET status = 'Paid', paid = COALESCE(paid, 0) + ?, balance = MAX(0, total - COALESCE(paid, 0) - ?)
		WHERE po_id = ?
	`, amount, amount, poID)
	return err
}

// MarkShipped sets ship_status on a PO.
func (s *Service) MarkShipped(poID, status string) error {
	_, err := s.DB.Exec("UPDATE purchase_orders SET ship_status = ? WHERE po_id = ?", status, poID)
	return err
}

// PendingActions returns count of POs needing attention.
func (s *Service) PendingActions() map[string]int {
	result := map[string]int{"approvals": 0, "payments": 0, "shipping": 0}
	var a, p, sh int
	s.DB.QueryRow("SELECT COUNT(*) FROM purchase_orders WHERE status = 'Pending Approval'").Scan(&a)
	s.DB.QueryRow("SELECT COUNT(*) FROM purchase_orders WHERE status = 'Pending Payment'").Scan(&p)
	s.DB.QueryRow("SELECT COUNT(*) FROM purchase_orders WHERE ship_status = 'Pending' AND status NOT IN ('VOID','CANCELLED')").Scan(&sh)
	result["approvals"] = a; result["payments"] = p; result["shipping"] = sh
	return result
}
