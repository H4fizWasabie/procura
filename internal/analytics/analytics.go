package analytics

import (
	"database/sql"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

var monthLabels = []string{"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"}

// Frozen baselines from GAS (prevents retroactive changes)
var frozenInHouse = map[int]map[int]float64{
	2025: {0:2600,1:3700,2:7300,3:6400,4:17300,5:9200,6:16900,7:7200,8:12700,9:8400,10:24800,11:8000},
	2026: {0:10400,1:27800,2:32600,5:15576,6:20851.69},
}
var frozenVal = map[int]map[int]float64{
	2025: {0:74100,1:112700,2:166400,3:175700,4:216100,5:277900,6:312300,7:325100,8:326300,9:359700,10:320900,11:323200},
	2026: {0:433000,1:403400,2:386400,5:393548},
}
var frozenCons = map[int]map[int]float64{
	2025: {0:37400,1:57000,2:52400,3:59500,4:88500,5:68300,6:82900,7:82000,8:106400,9:118000,10:154300,11:153800},
	2026: {0:170300,1:177100,2:268200,5:220621},
}
var frozenRev = map[int]map[int]float64{
	2025: {0:82400,1:145600,2:112300,3:128300,4:198100,5:146200,6:172600,7:174000,8:211500,9:244900,10:340000,11:327900},
	2026: {0:352700,1:365000,2:423500,5:491096},
}
var legacy2025Spend = map[int]float64{0:32289.11,1:78097.61,2:70487.43,3:43317.38,4:74125.33,5:94482.73,6:75682.60,7:54335.47,8:72744.05,9:82888.69,10:92302.24}
var legacy2026Spend = map[int]float64{0:198000,1:153181,2:146032,3:128991,4:129408,5:172574}

type Metrics struct {
	Labels    []string            `json:"labels"`
	Finance   FinanceMetrics      `json:"finance"`
	Operation OperationMetrics    `json:"operation"`
	Inventory InventoryMetrics    `json:"inventory"`
	Supplier  SupplierMetrics     `json:"supplier"`
	Business  BusinessMetrics     `json:"business"`
}
type FinanceMetrics struct {
	TotalSpend     float64            `json:"totalSpend"`
	UnpaidPO       float64            `json:"unpaidPo"`
	InventoryAsset float64            `json:"inventoryAsset"`
	MonthlySpend   []float64          `json:"monthlySpend"`
	DeptSpend      map[string]float64 `json:"deptSpend"`
}
type OperationMetrics struct {
	POCount            int                   `json:"poCount"`
	RestockCost        float64               `json:"restockCost"`
	CriticalItems      []CriticalItem        `json:"criticalItems"`
	InHouseConsumption []float64             `json:"inHouseConsumption"`
	InHouseTopItems    []InHouseItem         `json:"inHouseTopItems"`
}
type InventoryMetrics struct {
	ValuationTrend    []float64    `json:"valuationTrend"`
	ConsumptionTrend  []float64    `json:"consumptionTrend"`
	HighMovers        []MoverItem  `json:"highMovers"`
	DeadStock         []DeadItem   `json:"deadStock"`
}
type SupplierMetrics struct {
	TopSuppliers       map[string]float64 `json:"topSuppliers"`
	PerformanceRanking []PerfRank         `json:"performanceRanking"`
	RadarData          RadarData          `json:"radarData"`
}
type BusinessMetrics struct {
	GrossRevenueTrend  []float64            `json:"grossRevenueTrend"`
	ProductTypeSplit   map[string]float64   `json:"productTypeSplit"`
	TopTurnoverItems   []TurnoverItem       `json:"topTurnoverItems"`
	SeasonalTrends     SeasonalTrends       `json:"seasonalTrends"`
}
type CriticalItem struct{Name string `json:"name"`; Gap float64 `json:"gap"`; Cost float64 `json:"cost"`}
type InHouseItem struct{Name string `json:"name"`; TotalVal float64 `json:"totalVal"`; PeakMonth string `json:"peakMonth"`}
type MoverItem struct{Name string `json:"name"`; Qty float64 `json:"qty"`; Val float64 `json:"val"`}
type DeadItem struct{Name string `json:"name"`}
type PerfRank struct{Name string `json:"name"`; Avg float64 `json:"avg"`; Count int `json:"count"`}
type RadarData struct{Acc float64 `json:"acc"`; Spd float64 `json:"spd"`; Qual float64 `json:"qual"`}
type TurnoverItem struct{Name string `json:"name"`; Revenue float64 `json:"revenue"`}
type SeasonalTrends struct{Labels []string `json:"labels"`; Datasets []TrendDataset `json:"datasets"`}
type TrendDataset struct{Label string `json:"label"`; Data []float64 `json:"data"`; BorderColor string `json:"borderColor"`}

type itemMeta struct{name,typ,cat,beh string; cost,sell,cur,rop float64}
type itemAcc struct{name string; totalOut,revenue float64; monthly,ihMonthly,revMonthly,valMonthly []float64; meta itemMeta}

// snapshot of the items table: per-item metadata plus derived critical/asset figures
func (s *Service) loadItems() (itemMap map[string]itemMeta, critical []CriticalItem, restockCost, inventoryAsset float64) {
	itemMap = map[string]itemMeta{}
	rows, _ := s.DB.Query("SELECT stock_id, item_name, cost, selling_price, current_stock, rop, product_type, category, item_behaviour FROM items")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id,name,pt,cat,beh sql.NullString; var cost,sell,cur,rop sql.NullFloat64
			rows.Scan(&id,&name,&cost,&sell,&cur,&rop,&pt,&cat,&beh)
			if !id.Valid { continue }
			im := itemMeta{name: strv(name), typ: strv(pt), cat: strv(cat), beh: strv(beh),
				cost: f64v(cost), sell: f64v(sell), cur: f64v(cur), rop: f64v(rop)}
			itemMap[strings.ToUpper(strings.TrimSpace(id.String))] = im
			cv, cst := im.cur, im.cost
			inventoryAsset += cv * cst
			r := im.rop
			if r > 0 && cv < r {
				gap := r - cv
				restockCost += gap * cst
				critical = append(critical, CriticalItem{Name: strv(name), Gap: gap, Cost: gap*cst})
			}
		}
	}
	return
}

// per-item movement accumulation over a window; trends are derived from it by callers
func (s *Service) scanMovements(window [][2]int, itemMap map[string]itemMeta) map[string]*itemAcc {
	allItems := map[string]*itemAcc{}
	for _, w := range window {
		rows, _ := s.DB.Query("SELECT stock_id, item_name, month, out_qty, adj_out, report_closing FROM stock_movements WHERE year=? AND month=?", w[0], w[1]+1)
		if rows==nil { continue }
		for rows.Next() {
			var sid,name sql.NullString; var mo int; var outQ,adjO,closing sql.NullFloat64
			rows.Scan(&sid,&name,&mo,&outQ,&adjO,&closing)
			id := strings.ToUpper(strings.TrimSpace(strv(sid)))
			if id=="" { continue }
			i := -1
			for k, ww := range window { if ww[0]==w[0] && ww[1]==mo-1 { i=k; break } }
			if i==-1 { continue }
			meta := itemMap[id]
			acc := allItems[id]
			if acc == nil {
				acc = &itemAcc{name:strv(name), monthly:make([]float64,len(window)), ihMonthly:make([]float64,len(window)), revMonthly:make([]float64,len(window)), valMonthly:make([]float64,len(window)), meta:meta}
				allItems[id] = acc
			}
			totalOut := f64v(outQ)+f64v(adjO)
			acc.totalOut += totalOut; acc.monthly[i] += totalOut
			acc.valMonthly[i] += f64v(closing)*meta.cost
			if strings.ToLower(strings.TrimSpace(meta.beh))=="in-house use" { acc.ihMonthly[i] += totalOut*meta.cost }
			rev := totalOut*meta.sell
			acc.revenue += rev; acc.revMonthly[i] += rev
		}
		rows.Close()
	}
	return allItems
}

func (s *Service) getSetting(key string) string {
	var v sql.NullString
	s.DB.QueryRow("SELECT value FROM settings WHERE key=?", key).Scan(&v)
	return v.String
}
func (s *Service) setSetting(key, value string) error {
	_, err := s.DB.Exec("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value)
	return err
}

// user-frozen baselines from settings (key "analytics_frozen": {year:{month:{ih,val,cons,rev}}})
func (s *Service) settingsFrozen() map[string]map[string]map[string]float64 {
	m := map[string]map[string]map[string]float64{}
	if raw := s.getSetting("analytics_frozen"); raw != "" {
		json.Unmarshal([]byte(raw), &m)
	}
	return m
}

// Freeze snapshots the four monthly trends for a month into settings; re-freezing is idempotent.
func (s *Service) Freeze(year, month int) (map[string]float64, error) {
	m := s.Compute(year, month, year, month)
	vals := map[string]float64{"ih":m.Operation.InHouseConsumption[0], "val":m.Inventory.ValuationTrend[0], "cons":m.Inventory.ConsumptionTrend[0], "rev":m.Business.GrossRevenueTrend[0]}
	frozen := s.settingsFrozen()
	key := strconv.Itoa(year)
	if frozen[key] == nil { frozen[key] = map[string]map[string]float64{} }
	frozen[key][strconv.Itoa(month)] = vals
	b, err := json.Marshal(frozen)
	if err != nil { return vals, err }
	return vals, s.setSetting("analytics_frozen", string(b))
}

// Service exposes analytics metrics
type Service struct{DB *sql.DB}

func (s *Service) Compute(fromYear, fromMonth, toYear, toMonth int) Metrics {
	window := buildWindow(fromYear, fromMonth, toYear, toMonth)
	ws := len(window)
	labels := make([]string, ws)
	for i, w := range window { labels[i] = monthLabels[w[1]] + " " + itoa(w[0])[2:] }

	m := Metrics{Labels: labels}
	m.Finance.MonthlySpend = make([]float64, ws)
	m.Finance.DeptSpend = map[string]float64{}
	m.Operation.InHouseConsumption = make([]float64, ws)
	m.Inventory.ValuationTrend = make([]float64, ws)
	m.Inventory.ConsumptionTrend = make([]float64, ws)
	m.Business.GrossRevenueTrend = make([]float64, ws)
	m.Supplier.TopSuppliers = map[string]float64{}
	m.Supplier.RadarData = RadarData{}
	m.Business.ProductTypeSplit = map[string]float64{}
	m.Business.SeasonalTrends = SeasonalTrends{Labels: labels}

	idx := func(y, mo int) int {
		for i, w := range window { if w[0]==y && w[1]==mo { return i } }
		return -1
	}

	// Item map
	itemMap, criticalItems, restockCost, inventoryAsset := s.loadItems()
	m.Finance.InventoryAsset = inventoryAsset
	m.Operation.RestockCost = restockCost
	m.Operation.CriticalItems = criticalItems
	sort.Slice(m.Operation.CriticalItems, func(i,j int)bool{return m.Operation.CriticalItems[i].Cost>m.Operation.CriticalItems[j].Cost})
	if len(m.Operation.CriticalItems)>10 { m.Operation.CriticalItems = m.Operation.CriticalItems[:10] }

	// PO scan
	rows, _ := s.DB.Query("SELECT po_id, date, total, status, department, supplier FROM purchase_orders")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var poID, dateStr, status, dept, supplier sql.NullString; var total sql.NullFloat64
			rows.Scan(&poID,&dateStr,&total,&status,&dept,&supplier)
			st := strings.ToUpper(strings.TrimSpace(strv(status)))
			if st=="VOID"||st=="CANCELLED"||st=="REJECT" { continue }
			i := -1
			if d := parseDate(strv(dateStr), strv(poID)); d != nil { i = idx(d.Year(), int(d.Month())-1) }
			if i == -1 { continue }
			t := f64v(total)
			m.Finance.TotalSpend += t
			m.Finance.MonthlySpend[i] += t
			dp := strv(dept); if dp=="" { dp="General" }
			m.Finance.DeptSpend[dp] += t
			m.Operation.POCount++
			sup := strv(supplier); if sup=="" { sup="Unknown" }
			m.Supplier.TopSuppliers[sup] += t
			if st=="PENDING PAYMENT"||st=="APPROVED" { m.Finance.UnpaidPO += t }
		}
	}

	// Movement data
	allItems := s.scanMovements(window, itemMap)
	for _, acc := range allItems {
		for i := range window {
			m.Inventory.ValuationTrend[i] += acc.valMonthly[i]
			m.Inventory.ConsumptionTrend[i] += acc.monthly[i]*acc.meta.cost
			m.Operation.InHouseConsumption[i] += acc.ihMonthly[i]
			m.Business.GrossRevenueTrend[i] += acc.revMonthly[i]
		}
	}

	// Apply frozen data (settings overrides legacy GAS baselines)
	sf := s.settingsFrozen()
	for i, w := range window {
		if v, ok := frozenInHouse[w[0]][w[1]]; ok { m.Operation.InHouseConsumption[i] = v }
		if v, ok := frozenVal[w[0]][w[1]]; ok { m.Inventory.ValuationTrend[i] = v }
		if v, ok := frozenCons[w[0]][w[1]]; ok { m.Inventory.ConsumptionTrend[i] = v }
		if v, ok := frozenRev[w[0]][w[1]]; ok { m.Business.GrossRevenueTrend[i] = v }
		if fs, ok := sf[strconv.Itoa(w[0])][strconv.Itoa(w[1])]; ok {
			if v, ok := fs["ih"]; ok { m.Operation.InHouseConsumption[i] = v }
			if v, ok := fs["val"]; ok { m.Inventory.ValuationTrend[i] = v }
			if v, ok := fs["cons"]; ok { m.Inventory.ConsumptionTrend[i] = v }
			if v, ok := fs["rev"]; ok { m.Business.GrossRevenueTrend[i] = v }
		}
		if w[0]==2025 { if v, ok := legacy2025Spend[w[1]]; ok { m.Finance.MonthlySpend[i] = v } }
		if w[0]==2026 { if v, ok := legacy2026Spend[w[1]]; ok { m.Finance.MonthlySpend[i] = v } }
	}

	// Product type split & high movers
	allowedTypes := map[string]bool{"medicine":true,"pet food":true,"lab":true,"test kit":true,"vaccination":true}
	deadTypes := map[string]bool{"medicine":true,"supplement":true,"vaccination":true,"pet food":true}
	for _, acc := range allItems {
		usage := acc.totalOut * acc.meta.cost
		if usage > 0 { m.Business.ProductTypeSplit[acc.meta.typ] += usage }
	}
	high := []*itemAcc{}
	for _, acc := range allItems {
		tl := strings.ToLower(acc.meta.typ); cl := strings.ToLower(acc.meta.cat)
		if strings.Contains(tl,"surgical")||strings.Contains(cl,"surgical") { continue }
		ok := false
		for t := range allowedTypes { if strings.Contains(tl,t)||strings.Contains(cl,t) { ok=true; break } }
		if !ok { continue }
		high = append(high, acc)
	}
	sort.Slice(high, func(i,j int)bool{return high[i].totalOut>high[j].totalOut})
	for i:=0; i<10 && i<len(high); i++ { m.Inventory.HighMovers = append(m.Inventory.HighMovers, MoverItem{Name:high[i].name, Qty:high[i].totalOut}) }

	// Dead stock
	for id, acc := range allItems {
		meta := itemMap[id]
		if meta.cur<=0 || acc.totalOut>0 { continue }
		tl := strings.ToLower(meta.typ); cl := strings.ToLower(meta.cat)
		ok := false
		for t := range deadTypes { if strings.Contains(tl,t)||strings.Contains(cl,t) { ok=true; break } }
		if !ok { continue }
		m.Inventory.DeadStock = append(m.Inventory.DeadStock, DeadItem{Name:acc.name})
		if len(m.Inventory.DeadStock)>=10 { break }
	}

	// Top turnover
	allVals := make([]*itemAcc,0,len(allItems))
	for _, acc := range allItems { allVals = append(allVals, acc) }
	sort.Slice(allVals, func(i,j int)bool{return allVals[i].revenue>allVals[j].revenue})
	for i:=0; i<10 && i<len(allVals); i++ { m.Business.TopTurnoverItems = append(m.Business.TopTurnoverItems, TurnoverItem{Name:allVals[i].name, Revenue:allVals[i].revenue}) }

	// In-house top
	ih := []*itemAcc{}
	for _, acc := range allItems {
		has := false
		for _, v := range acc.ihMonthly { if v>0 { has=true; break } }
		if has { ih = append(ih, acc) }
	}
	sort.Slice(ih, func(i,j int)bool{return sum(ih[i].ihMonthly)>sum(ih[j].ihMonthly)})
	for i:=0; i<20 && i<len(ih); i++ {
		peak := "-"
		if mx := maxIdx(ih[i].ihMonthly); mx>=0 { peak = labels[mx] }
		m.Operation.InHouseTopItems = append(m.Operation.InHouseTopItems, InHouseItem{Name:ih[i].name, TotalVal:sum(ih[i].ihMonthly), PeakMonth:peak})
	}

	// Seasonal trends (top 5 movers)
	top5 := make([]*itemAcc,0,len(allItems))
	for _, acc := range allItems { top5 = append(top5, acc) }
	sort.Slice(top5, func(i,j int)bool{return top5[i].totalOut>top5[j].totalOut})
	colors := []string{"#3b82f6","#ef4444","#10b981","#f59e0b","#8b5cf6"}
	for i:=0; i<5 && i<len(top5); i++ {
		m.Business.SeasonalTrends.Datasets = append(m.Business.SeasonalTrends.Datasets, TrendDataset{Label:top5[i].name, Data:top5[i].monthly, BorderColor:colors[i]})
	}

	// Supplier performance
	rows, _ = s.DB.Query("SELECT supplier_name, quality, accuracy, speed FROM supplier_performance")
	if rows != nil {
		defer rows.Close()
		type supStat struct{acc,spd,qual float64; count int}
		stats := map[string]*supStat{}
		var gAcc, gSpd, gQual float64; gCnt := 0
		for rows.Next() {
			var name sql.NullString; var q,a,sp sql.NullFloat64
			rows.Scan(&name,&q,&a,&sp)
			sup := strings.TrimSpace(strv(name))
			if sup==""||sup=="Unknown" { continue }
			if _, ok := stats[sup]; !ok { stats[sup] = &supStat{} }
			ss := stats[sup]; ss.acc+=f64v(a); ss.spd+=f64v(sp); ss.qual+=f64v(q); ss.count++
			gAcc+=f64v(a); gSpd+=f64v(sp); gQual+=f64v(q); gCnt++
		}
		for name, ss := range stats {
			m.Supplier.PerformanceRanking = append(m.Supplier.PerformanceRanking, PerfRank{Name:name, Avg:math.Round((ss.acc+ss.spd+ss.qual)/(3*float64(ss.count))*10)/10, Count:ss.count})
		}
		sort.Slice(m.Supplier.PerformanceRanking, func(i,j int)bool{return m.Supplier.PerformanceRanking[i].Avg>m.Supplier.PerformanceRanking[j].Avg})
		if len(m.Supplier.PerformanceRanking)>10 { m.Supplier.PerformanceRanking = m.Supplier.PerformanceRanking[:10] }
		if gCnt>0 {
			m.Supplier.RadarData = RadarData{Acc:math.Round(gAcc/float64(gCnt)*10)/10, Spd:math.Round(gSpd/float64(gCnt)*10)/10, Qual:math.Round(gQual/float64(gCnt)*10)/10}
		}
	}

	return m
}

func buildWindow(fy,fm,ty,tm int) [][2]int {
	var w [][2]int
	y,m := fy,fm
	for y<ty || (y==ty && m<=tm) {
		w = append(w, [2]int{y,m})
		m++; if m>11 { m=0; y++ }
		if len(w)>36 { break }
	}
	return w
}

func parseDate(dateStr, poID string) *time.Time {
	for _, fmt := range []string{"2006-01-02","2006-01-02T15:04:05","02/01/2006"} {
		if t, err := time.Parse(fmt, strings.TrimSpace(dateStr)); err==nil { return &t }
	}
	return nil
}

// helpers
func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func f64v(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
func itoa(n int) string { s:=""; if n==0 { return "0" }; for n>0 { s=string(rune('0'+n%10))+s; n/=10 }; return s }
func sum(a []float64) float64 { s:=0.0; for _,v:=range a { s+=v }; return s }
func maxIdx(a []float64) int { if len(a)==0 { return -1 }; mx:=0; for i,v:=range a { if v>a[mx] { mx=i } }; return mx }
