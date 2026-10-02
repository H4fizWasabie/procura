package planning

import (
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"procura/internal/core"
)

// Excluded normalizes the loose legacy flag for planning and inventory browsing.
func Excluded(value string) bool {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "1", "TRUE", "YES", "EXCLUDE":
		return true
	}
	return false
}

var ErrAssistantAcknowledgement = errors.New("ASSISTANT cannot supply acknowledged_stock_ids; a human must create unavailable-item orders in the UI")
var ErrAssistantStockID = errors.New("ASSISTANT requires every line to have a stock_id matching an existing inventory item exactly")

// NotAvailable accepts the canonical value and its legacy spelling.
func NotAvailable(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "not-available", "unavailable":
		return true
	}
	return false
}

// RoutineEligible governs recommendations and alerts, never explicit purchases.
func RoutineEligible(policy, exclude, behaviour, status, productType, category string) bool {
	if policy != "routine" || Excluded(exclude) || NotAvailable(status) || surgical(productType, category) {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(behaviour)) {
	case "", "standard / pack", "in-house use":
		return true
	}
	return false
}

func surgical(productType, category string) bool {
	return strings.Contains(strings.ToLower(productType), "surgical") || strings.Contains(strings.ToLower(category), "surgical")
}

// Stockable governs ROP calculation independently of purchase intent and availability.
func Stockable(behaviour, productType, category string) bool {
	if surgical(productType, category) {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(behaviour)) {
	case "service", "asset", "unavailable":
		return false
	}
	return true
}

// Purchasable checks curated policy only; surgical and on-demand items are allowed.
func Purchasable(policy string) bool {
	return policy == "routine" || policy == "on_demand"
}

// BelowROP is the strict threshold shared by every low-stock view.
func BelowROP(stock, rop float64) bool { return rop > 0 && stock < rop }

// PurchaseError tells callers whether a new line is blocked or needs acknowledgement.
type PurchaseError struct {
	StockID, Name, Policy string
	AvailabilityOverride  bool
}

func (e *PurchaseError) Error() string {
	if e.AvailabilityOverride {
		return fmt.Sprintf("%s (%s) is not-available; explicitly acknowledge the availability warning to proceed", e.Name, e.StockID)
	}
	policy := e.Policy
	if policy == "" {
		policy = "unclassified"
	}
	return fmt.Sprintf("%s (%s) has purchase policy %s; change the purchase policy first", e.Name, e.StockID, policy)
}

// CheckPurchase applies only to newly added linked PO/RFQ lines. Its result
// identifies a successful availability override for the save's audit log.
func CheckPurchase(db core.RowQuerier, stockID string, acknowledged []string) (bool, error) {
	if stockID == "" {
		return false, nil
	}
	var name string
	var policy, status sql.NullString
	err := db.QueryRow(`SELECT COALESCE(NULLIF(item_name,''),stock_id), purchase_policy, product_status
		FROM items WHERE stock_id=?`, stockID).Scan(&name, &policy, &status)
	// Unresolved/free-text lines have no inventory policy; existing linkage
	// validation continues to surface them separately.
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !Purchasable(policy.String) {
		return false, &PurchaseError{StockID: stockID, Name: name, Policy: policy.String}
	}
	unavailable := NotAvailable(status.String)
	if unavailable && !slices.Contains(acknowledged, stockID) {
		return false, &PurchaseError{StockID: stockID, Name: name, AvailabilityOverride: true}
	}
	return unavailable, nil
}

// LogAvailabilityOverrides commits the acknowledgement with the saved document.
func LogAvailabilityOverrides(tx *sql.Tx, user, module, documentID string, stockIDs []string) error {
	if len(stockIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(`INSERT INTO logs(timestamp,user_email,action,module,context,details)
		VALUES(?,?,'AVAILABILITY_OVERRIDE',?,?,?)`, time.Now().Format(time.RFC3339), user, module, documentID,
		"Acknowledged not-available items: "+strings.Join(stockIDs, ", "))
	return err
}

// DirectOrderWarnings never gate a historical order; curated controls are shown
// as warnings because the order was already placed.
func DirectOrderWarnings(db *sql.DB, stockID string) ([]string, error) {
	var name string
	var policy, status sql.NullString
	err := db.QueryRow(`SELECT COALESCE(NULLIF(item_name,''),stock_id),purchase_policy,product_status
		FROM items WHERE stock_id=?`, stockID).Scan(&name, &policy, &status)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var warnings []string
	if !Purchasable(policy.String) {
		label := policy.String
		if label == "" {
			label = "unclassified"
		}
		warnings = append(warnings, fmt.Sprintf("%s (%s) has purchase policy %s; direct order recorded, review the policy before future PO/RFQ purchases", name, stockID, label))
	}
	if NotAvailable(status.String) {
		warnings = append(warnings, fmt.Sprintf("%s (%s) is not-available", name, stockID))
	}
	return warnings, nil
}

// CheckAssistantPurchase requires exact inventory linkage and never acknowledges availability.
func CheckAssistantPurchase(db core.RowQuerier, stockID string) error {
	var exists bool
	if strings.TrimSpace(stockID) != "" {
		if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM items WHERE stock_id COLLATE BINARY = ?)`, stockID).Scan(&exists); err != nil {
			return err
		}
	}
	if !exists {
		return fmt.Errorf("stock_id %q: %w", stockID, ErrAssistantStockID)
	}
	_, err := CheckPurchase(db, stockID, nil)
	var failure *PurchaseError
	if errors.As(err, &failure) && failure.AvailabilityOverride {
		return fmt.Errorf("%w; ASSISTANT cannot override availability; a human must create this PO/RFQ in the UI", err)
	}
	return err
}
