package suppliers

import (
	"database/sql"
	"strings"
)

type Supplier struct {
	SupplierName  string `json:"supplier_name"`
	ContactPerson string `json:"contact_person"`
	Phone         string `json:"phone"`
	Email         string `json:"email"`
	Address       string `json:"address"`
	PaymentTerms  string `json:"payment_terms"`
	BRN           string `json:"brn"`
	AccountNo     string `json:"account_no"`
	BankName      string `json:"bank_name"`
}

type Service struct {
	DB *sql.DB
}

// List returns all suppliers sorted by name.
func (s *Service) List(search string) []Supplier {
	var rows *sql.Rows
	var err error
	if search != "" {
		term := "%" + strings.ToLower(search) + "%"
		rows, err = s.DB.Query(`
			SELECT supplier_name, contact_person, phone, email, address,
			       payment_terms, brn, account_no, bank_name
			FROM suppliers
			WHERE LOWER(supplier_name) LIKE ?
			   OR LOWER(contact_person) LIKE ?
			ORDER BY supplier_name
		`, term, term)
	} else {
		rows, err = s.DB.Query(`
			SELECT supplier_name, contact_person, phone, email, address,
			       payment_terms, brn, account_no, bank_name
			FROM suppliers ORDER BY supplier_name
		`)
	}
	if err != nil {
		return []Supplier{}
	}
	defer rows.Close()
	return scanSuppliers(rows)
}

// Save creates or updates a supplier. Uses originalName to find existing record for renames.
func (s *Service) Save(sup Supplier, originalName string) error {
	if originalName == "" {
		originalName = sup.SupplierName
	}
	var exists int
	s.DB.QueryRow("SELECT COUNT(*) FROM suppliers WHERE supplier_name = ?", originalName).Scan(&exists)
	if exists > 0 {
		_, err := s.DB.Exec(`
			UPDATE suppliers SET supplier_name=?, contact_person=?, phone=?, email=?,
			    address=?, payment_terms=?, brn=?, account_no=?, bank_name=?
			WHERE supplier_name = ?
		`, sup.SupplierName, sup.ContactPerson, sup.Phone, sup.Email, sup.Address,
			sup.PaymentTerms, sup.BRN, sup.AccountNo, sup.BankName, originalName)
		return err
	}
	_, err := s.DB.Exec(`
		INSERT OR IGNORE INTO suppliers
			(supplier_name, contact_person, phone, email, address, payment_terms, brn, account_no, bank_name)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, sup.SupplierName, sup.ContactPerson, sup.Phone, sup.Email, sup.Address,
		sup.PaymentTerms, sup.BRN, sup.AccountNo, sup.BankName)
	return err
}

// Delete removes a supplier. Admin only enforced at route level.
func (s *Service) Delete(supplierName string) error {
	_, err := s.DB.Exec("DELETE FROM suppliers WHERE supplier_name = ?", supplierName)
	return err
}

// Names returns supplier names only (for dropdowns).
func (s *Service) Names() []string {
	rows, _ := s.DB.Query("SELECT supplier_name FROM suppliers ORDER BY supplier_name")
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		out = append(out, n)
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func scanSuppliers(rows *sql.Rows) []Supplier {
	out := []Supplier{}
	for rows.Next() {
		var s Supplier
		rows.Scan(&s.SupplierName, &s.ContactPerson, &s.Phone, &s.Email,
			&s.Address, &s.PaymentTerms, &s.BRN, &s.AccountNo, &s.BankName)
		out = append(out, s)
	}
	return out
}
