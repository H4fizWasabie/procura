package analytics

import (
	"bytes"
	"fmt"
	"sort"

	"github.com/xuri/excelize/v2"
)

// Export builds an xlsx workbook with a monthly summary plus item-level
// breakdowns for every analytics category over the window.
func (s *Service) Export(fy, fm, ty, tm int) ([]byte, error) {
	m := s.Compute(fy, fm, ty, tm)
	itemMap, _, _, _ := s.loadItems()
	accs := s.scanMovements(buildWindow(fy, fm, ty, tm), itemMap)

	f := excelize.NewFile()
	f.SetSheetName("Sheet1", "Summary")
	summary := [][]any{}
	for i, l := range m.Labels {
		summary = append(summary, []any{l,
			m.Finance.MonthlySpend[i], m.Operation.InHouseConsumption[i],
			m.Inventory.ValuationTrend[i], m.Inventory.ConsumptionTrend[i],
			m.Business.GrossRevenueTrend[i]})
	}
	writeSheet(f, "Summary", []string{"Month", "Spend", "In-House", "Valuation", "Consumption", "Revenue"}, summary)

	kpis := [][]any{
		[]any{"Total PO Spend", m.Finance.TotalSpend},
		[]any{"Outstanding Payables", m.Finance.UnpaidPO},
		[]any{"Inventory Asset", m.Finance.InventoryAsset},
		[]any{"Total POs Issued", m.Operation.POCount},
		[]any{"Est. Restock Cost", m.Operation.RestockCost},
		[]any{"Active Suppliers", len(m.Supplier.TopSuppliers)},
	}
	writeSheet(f, "KPIs", []string{"Metric", "Value"}, kpis)

	ih, cons, rev, qty := []*itemAcc{}, []*itemAcc{}, []*itemAcc{}, []*itemAcc{}
	for _, acc := range accs {
		if sum(acc.ihMonthly) > 0 { ih = append(ih, acc) }
		if acc.totalOut*acc.meta.cost > 0 { cons = append(cons, acc) }
		if acc.revenue > 0 { rev = append(rev, acc) }
		if acc.totalOut > 0 { qty = append(qty, acc) }
	}
	byVal := func(a, b *itemAcc) bool { return a.revenue > b.revenue }
	sort.Slice(ih, func(a, b int) bool { return sum(ih[a].ihMonthly) > sum(ih[b].ihMonthly) })
	sort.Slice(cons, func(a, b int) bool { return cons[a].totalOut*cons[a].meta.cost > cons[b].totalOut*cons[b].meta.cost })
	sort.Slice(rev, func(a, b int) bool { return byVal(rev[a], rev[b]) })
	sort.Slice(qty, func(a, b int) bool { return qty[a].totalOut > qty[b].totalOut })

	rows := func(list []*itemAcc, val func(*itemAcc) float64) [][]any {
		out, tot, totQ := [][]any{}, 0.0, 0.0
		for _, acc := range list {
			v := val(acc)
			out = append(out, []any{acc.name, acc.totalOut, v})
			tot += v; totQ += acc.totalOut
		}
		return append(out, []any{"TOTAL", totQ, tot})
	}
	writeSheet(f, "In-House Items", []string{"Item", "Qty", "Value (RM)"}, rows(ih, func(a *itemAcc) float64 { return sum(a.ihMonthly) }))
	writeSheet(f, "Consumption Items", []string{"Item", "Qty", "Value (RM)"}, rows(cons, func(a *itemAcc) float64 { return a.totalOut * a.meta.cost }))

	turnover := [][]any{}
	for _, acc := range rev { turnover = append(turnover, []any{acc.name, acc.revenue}) }
	writeSheet(f, "Top Turnover", []string{"Item", "Revenue (RM)"}, turnover)
	movers := [][]any{}
	for _, acc := range qty { movers = append(movers, []any{acc.name, acc.totalOut}) }
	writeSheet(f, "Top Movers", []string{"Item", "Qty"}, movers)

	critical := [][]any{}
	for _, c := range m.Operation.CriticalItems { critical = append(critical, []any{c.Name, c.Gap, c.Cost}) }
	writeSheet(f, "Critical Items", []string{"Item", "Gap", "Cost (RM)"}, critical)

	dept := [][]any{}
	for name, v := range m.Finance.DeptSpend { dept = append(dept, []any{name, v}) }
	sort.Slice(dept, func(a, b int) bool { return dept[a][1].(float64) > dept[b][1].(float64) })
	writeSheet(f, "Department Spend", []string{"Department", "Spend (RM)"}, dept)

	types := [][]any{}
	for name, v := range m.Business.ProductTypeSplit { types = append(types, []any{name, v}) }
	sort.Slice(types, func(a, b int) bool { return types[a][1].(float64) > types[b][1].(float64) })
	writeSheet(f, "Product Types", []string{"Type", "Dispensing Cost (RM)"}, types)

	rank := [][]any{}
	for _, r := range m.Supplier.PerformanceRanking { rank = append(rank, []any{r.Name, r.Count, r.Avg}) }
	writeSheet(f, "Supplier Ranking", []string{"Supplier", "Tx", "Avg Score"}, rank)

	scores := [][]any{[]any{"Accuracy", m.Supplier.RadarData.Acc}, []any{"Speed", m.Supplier.RadarData.Spd}, []any{"Quality", m.Supplier.RadarData.Qual}}
	writeSheet(f, "Scorecard Radar", []string{"Metric", "Avg (0-5)"}, scores)

	if len(m.Business.SeasonalTrends.Datasets) > 0 {
		seas := [][]any{}
		head := []any{"Item"}
		for _, l := range m.Labels { head = append(head, l) }
		for _, ds := range m.Business.SeasonalTrends.Datasets {
			row := []any{ds.Label}
			for _, v := range ds.Data { row = append(row, v) }
			seas = append(seas, row)
		}
		writeSheet(f, "Seasonal Trends", hdr(head), seas)
	}

	suppliers := [][]any{}
	for name, v := range m.Supplier.TopSuppliers { suppliers = append(suppliers, []any{name, v}) }
	sort.Slice(suppliers, func(a, b int) bool { return suppliers[a][1].(float64) > suppliers[b][1].(float64) })
	writeSheet(f, "Top Suppliers", []string{"Supplier", "Spend (RM)"}, suppliers)

	dead := [][]any{}
	for _, d := range m.Inventory.DeadStock { dead = append(dead, []any{d.Name}) }
	writeSheet(f, "Dead Stock", []string{"Item"}, dead)

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil { return nil, err }
	return buf.Bytes(), nil
}

func writeSheet(f *excelize.File, name string, headers []string, rows [][]any) {
	idx, _ := f.NewSheet(name)
	style, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	for i, h := range headers {
		c, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(name, c, h)
		f.SetCellStyle(name, c, c, style)
	}
	for r, row := range rows {
		for i, v := range row {
			c, _ := excelize.CoordinatesToCellName(i+1, r+2)
			f.SetCellValue(name, c, v)
		}
	}
	f.SetColWidth(name, "A", "A", 55)
	f.SetColWidth(name, "B", "Z", 14)
	f.SetActiveSheet(idx)
}

func hdr(a []any) []string {
	s := make([]string, len(a))
	for i, v := range a { s[i] = fmt.Sprint(v) }
	return s
}
