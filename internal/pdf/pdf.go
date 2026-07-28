// Package pdf generates PO and RFQ PDFs via Chrome headless.
package pdf

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// RenderPOHTML returns the PO HTML page for the given data.
// Layout: traditional pre-printed form — header, vendor/metadata side-by-side,
// 20-row items table, footer disclaimer, 3-column signatures. Single A4 page.
func RenderPOHTML(poID, date, supplier, department, terms, invoiceDate string, total float64, items []map[string]interface{}, supplierData map[string]string, logoB64, signB64 string) string {
	type itemRow struct {
		Num   int
		Name  string
		Qty   string
		Cost  string
		Total string
	}
	var rows []itemRow
	for i, it := range items {
		name, _ := it["item_name"].(string)
		qty := toFloat(it["quantity"])
		cost := toFloat(it["cost"])
		lineTotal := toFloat(it["total"])
		if lineTotal == 0 {
			lineTotal = qty * cost
		}
		rows = append(rows, itemRow{
			Num:   i + 1,
			Name:  name,
			Qty:   fmtQty(qty),
			Cost:  fmtMoney(cost),
			Total: fmtMoney(lineTotal),
		})
	}

	// 20 fixed rows
	for len(rows) < 20 {
		rows = append(rows, itemRow{Num: len(rows) + 1})
	}

	var totalAmount float64
	if total > 0 {
		totalAmount = total
	} else {
		for _, it := range items {
			t := toFloat(it["total"])
			if t == 0 {
				t = toFloat(it["quantity"]) * toFloat(it["cost"])
			}
			totalAmount += t
		}
	}

	sup := supplierData
	if sup == nil {
		sup = map[string]string{}
	}

	displayDate := fmtDate(date)
	invDate := fmtDate(invoiceDate)
	supName := supplier
	if supName == "" {
		supName = "N/A"
	}
	termsDisplay := terms
	if termsDisplay == "" {
		termsDisplay = "-"
	}

	logoImg := ""
	if logoB64 != "" {
		logoImg = fmt.Sprintf(`<img src="data:image/png;base64,%s" style="width:180px;height:auto;display:block;" alt="logo">`, logoB64)
	}
	signImg := ""
	if signB64 != "" {
		signImg = fmt.Sprintf(`<img src="data:image/png;base64,%s" class="sig-img" alt="sign">`, signB64)
	}

	todaySig := fmtDate(time.Now().Format("2006-01-02"))

	// --- Left side metadata lines ---
	deptLine := ""
	if strings.TrimSpace(department) != "" {
		deptLine = fmt.Sprintf(`<div class="po-meta">DEPT: %s</div>`, strings.ToUpper(strings.TrimSpace(department)))
	}
	invLine := ""
	if invDate != "" {
		invLine = fmt.Sprintf(`<div class="po-meta">INVOICE DATE: %s</div>`, invDate)
	}

	// --- Top-right: supplier financial box ---
	supplierBox := &bytes.Buffer{}
	supplierBox.WriteString(`<table class="supp-box">`)
	fmt.Fprintf(supplierBox, `<tr><td class="sb-lbl">TERMS</td><td class="sb-val">%s</td></tr>`, termsDisplay)
	if sup["brn"] != "" {
		fmt.Fprintf(supplierBox, `<tr><td class="sb-lbl">REG NO.</td><td class="sb-val">%s</td></tr>`, sup["brn"])
	}
	if sup["bank_name"] != "" {
		fmt.Fprintf(supplierBox, `<tr><td class="sb-lbl">BANK</td><td class="sb-val">%s</td></tr>`, strings.ToUpper(sup["bank_name"]))
	}
	if sup["account_no"] != "" {
		fmt.Fprintf(supplierBox, `<tr><td class="sb-lbl">ACC NO.</td><td class="sb-val">%s</td></tr>`, sup["account_no"])
	}
	supplierBox.WriteString(`</table>`)

	// --- Vendor block ---
	vendorAddr := sup["address"]
	vendorPhone := sup["phone"]
	attnLine := ""
	if sup["contact_person"] != "" {
		attnLine = fmt.Sprintf(`<div class="attn">Attn: %s</div>`, sup["contact_person"])
	}

	// --- Items grid ---
	itemRows := &bytes.Buffer{}
	for _, r := range rows {
		itemRows.WriteString(fmt.Sprintf(`<tr>
			<td class="it-num">%d</td>
			<td class="it-desc">%s</td>
			<td class="it-qty">%s</td>
			<td class="it-cost">%s</td>
			<td class="it-total">%s</td>
		</tr>
`, r.Num, r.Name, r.Qty, r.Cost, r.Total))
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
    @media screen { html { background: #e5e7eb; } body { max-width: 210mm; margin: 20px auto; padding: 10mm 12mm; background: #fff; box-shadow: 0 0 20px rgba(0,0,0,0.12); } }
    @media print { html, body { margin: 0; padding: 0; } }
    @page { size: A4; margin: 10mm 12mm; }
    body { font-family: 'Arial', 'Helvetica', sans-serif; font-size: 8.5pt; color: #000; line-height: 1.1; }
    .page-root { page-break-inside: avoid; }

    /* ── Header ── */
    .hdr-table { width: 100%%; border-collapse: collapse; margin-bottom: 0; }
    .hdr-table td { vertical-align: top; padding: 0; }
    .hdr-left { width: 60%%; padding-bottom: 4px; }
    .hdr-right { width: 40%%; text-align: right; padding-bottom: 4px; }
    .po-title { font-size: 14pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .po-instruction { font-size: 7pt; color: #555; margin-bottom: 3px; }
    .po-id { font-size: 9pt; font-weight: 700; margin-bottom: 2px; }
    .po-meta { font-size: 7.5pt; font-weight: 600; margin-top: 1px; }

    /* ── Supplier financial box (top-right) ── */
    .supp-box { width: 100%%; border-collapse: collapse; font-size: 8pt; border: 1px solid #000; }
    .supp-box td { padding: 2px 4px; border-bottom: 1px solid #ccc; }
    .sb-lbl { width: 38%%; font-weight: 700; font-size: 7pt; text-transform: uppercase; color: #555; text-align: right; }
    .sb-val { width: 62%%; font-weight: 600; }

    /* ── Address blocks ── */
    .addr-table { width: 100%%; border-collapse: collapse; margin: 6px 0; }
    .addr-table td { vertical-align: top; padding: 0; }
    .addr-box { border: 1px solid #000; padding: 4px 6px; height: 60px; font-size: 8pt; line-height: 1.15; }
    .addr-gap { width: 3%%; border: none; }
    .addr-title { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; margin-bottom: 2px; }
    .attn { font-size: 7.5pt; color: #333; }

    /* ── Items table ── */
    .items-table { width: 100%%; border-collapse: collapse; table-layout: fixed; margin-bottom: 0; }
    .items-table thead th { border: 1px solid #000; background: #f5f5f5; padding: 3px 4px; font-size: 7.5pt; font-weight: 700; text-align: center; text-transform: uppercase; }
    .items-table tbody td { border: 1px solid #000; padding: 2px 5px; height: 21px; font-size: 8pt; vertical-align: middle; line-height: 1.1; overflow: hidden; }
    .it-num { width: 28px; text-align: center; }
    .it-desc { text-align: left; }
    .it-qty { width: 44px; text-align: center; }
    .it-cost { width: 68px; text-align: right; }
    .it-total { width: 72px; text-align: right; font-weight: 600; }
    .total-row td { font-weight: 700; font-size: 8.5pt; background: #f0f0f0; border: 1px solid #000; height: 22px; }

    /* ── Footer ── */
    .disclaimer { font-size: 7pt; border: 1px solid #000; padding: 3px 5px; margin-top: 6px; line-height: 1.2; color: #333; }

    /* ── Signatures ── */
    .sig-table { width: 100%%; border-collapse: collapse; margin-top: 8px; }
    .sig-table td { width: 33.3%%; vertical-align: top; font-size: 7.5pt; padding-right: 8px; }
    .sig-table td:last-child { padding-right: 0; }
    .sig-title { font-weight: 700; text-transform: uppercase; border-bottom: 1px solid #000; padding-bottom: 1px; margin-bottom: 6px; font-size: 7.5pt; letter-spacing: 0.3px; }
    .sig-img { height: 44px; max-width: 130px; opacity: 0.9; display: block; }
    .sig-spacer { height: 44px; }
    .sig-name { font-size: 8pt; font-weight: 600; margin-top: 2px; }
    .sig-role { font-size: 7pt; color: #555; }
    .sig-date { font-size: 7pt; color: #888; margin-top: 1px; }
</style></head>
<body><div class="page-root">

  <!-- Header: logo + PO metadata left | PURCHASE ORDER title + supplier financials right -->
  <table class="hdr-table"><tr>
    <td class="hdr-left">
      %s
      <div class="po-instruction">The following number must appear on all invoices, bills<br>and acknowledgements relating to this PO:</div>
      <div class="po-id">PURCHASE ORDER: %s</div>
      <div class="po-meta">DATE: %s</div>
      %s%s
    </td>
    <td class="hdr-right">
      <div class="po-title">PURCHASE ORDER</div>
      %s
    </td>
  </tr></table>

  <!-- Address blocks: VENDOR left | SHIP TO right -->
  <table class="addr-table"><tr>
    <td width="48%%" class="addr-box">
      <div class="addr-title">VENDOR:</div>
      <strong>%s</strong><br>
      %s
      <span>%s</span>
      <div>%s</div>
    </td>
    <td class="addr-gap"></td>
    <td width="48%%" class="addr-box">
      <div class="addr-title">SHIP TO:</div>
      <strong>Pet Universe Starlight</strong><br>
      No 30, Jalan Sulaiman 1, Taman Ampang Hilir,<br>
      68000 Ampang Jaya, Selangor
    </td>
  </tr></table>

  <!-- Items -->
  <table class="items-table">
    <thead><tr>
      <th class="it-num">No.</th><th class="it-desc">DESCRIPTION</th><th class="it-qty">QTY</th><th class="it-cost">UNIT (RM)</th><th class="it-total">TOTAL (RM)</th>
    </tr></thead>
    <tbody>
      %s
      <tr class="total-row">
        <td colspan="4" style="text-align:right;">TOTAL</td>
        <td style="text-align:right;">%s</td>
      </tr>
    </tbody>
  </table>

  <!-- Disclaimer -->
  <div class="disclaimer">
    Please notify us immediately upon determination that fulfillment of this order cannot be completed in its entirety on or before the specified one (1) week deadline.
  </div>

  <!-- Signatures -->
  <table class="sig-table"><tr>
    <td>
      <div class="sig-title">Prepared By</div>
      %s
      <div class="sig-name">Mohammad Hafiz</div>
      <div class="sig-role">Procurement Officer</div>
      <div class="sig-date">Date: %s</div>
    </td>
    <td>
      <div class="sig-title">Approved By</div>
      <div class="sig-spacer"></div>
      <div class="sig-name">Dr. Lim</div>
      <div class="sig-role">Operation Director</div>
    </td>
    <td>
      <div class="sig-title">Checked By</div>
      <div class="sig-spacer"></div>
      <div class="sig-name">Mr. Boey</div>
      <div class="sig-role">Chief Financial Officer</div>
    </td>
  </tr></table>

</div></body></html>`,
		logoImg,
		poID, displayDate, deptLine, invLine,
		supplierBox.String(),
		supName, attnLine, vendorAddr, vendorPhone,
		itemRows.String(),
		fmtMoney(totalAmount),
		signImg, todaySig,
	)
}

// RenderRFQHTML returns the RFQ HTML page.
func RenderRFQHTML(rfqID, date, supplier string, items []map[string]interface{}, logoB64 string) string {
	dispDate := fmtDate(date)
	supName := supplier
	if supName == "" {
		supName = "N/A"
	}

	// Build 15 rows
	itemRows := &bytes.Buffer{}
	for i := 0; i < 15; i++ {
		bg := "#ffffff"
		if i%2 == 1 {
			bg = "#f8fafc"
		}
		num := i + 1
		var stockID, name, uom, qty string
		if i < len(items) {
			it := items[i]
			stockID, _ = it["stock_id"].(string)
			name, _ = it["item_name"].(string)
			uom, _ = it["uom"].(string)
			q := toFloat(it["qty"])
			if q != 0 {
				qty = fmtQty(q)
			}
		}
		fmt.Fprintf(itemRows, `<tr style="background-color:%s; height: 21px;">
          <td style="text-align:center; padding:5px; border-right: 1px solid #f1f5f9;">%d</td>
          <td style="text-align:center; border-right: 1px solid #f1f5f9;"><strong>%s</strong></td>
          <td style="padding-left:10px; border-right: 1px solid #f1f5f9;">%s</td>
          <td style="text-align:center; border-right: 1px solid #f1f5f9;">%s</td>
          <td style="text-align:center; font-weight:bold;">%s</td>
        </tr>
`, bg, num, stockID, name, uom, qty)
	}

	logoImg := ""
	if logoB64 != "" {
		logoImg = fmt.Sprintf(`<img src="data:image/png;base64,%s" style="width:200px;max-width:200px;height:auto;display:block;" alt="logo">`, logoB64)
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
    @media screen { html { background: #e5e7eb; } body { max-width: 210mm; margin: 20px auto; padding: 10mm 12mm; background: #fff; box-shadow: 0 0 20px rgba(0,0,0,0.12); } }
    @media print { html, body { margin: 0; padding: 0; } }
    @page { size: A4; margin: 10mm 12mm; }
    body { font-family: 'Helvetica', 'Arial', sans-serif; font-size: 10pt; color: #334155; line-height: 1.3; margin: 0; padding: 0; }
    .page-root { page-break-inside: avoid; }

    .header-wrap { margin-bottom: 12px; border-bottom: 3px solid #7E9C76; padding-bottom: 6px; }
    .header-table { width: 100%%; table-layout: fixed; }
    .header-table td { vertical-align: top; }
    .company-name { font-size: 16pt; font-weight: 800; color: #7E9C76; text-transform: uppercase; margin-bottom: 2px; }
    .company-sub { font-size: 10pt; font-weight: 600; color: #64748b; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px; }
    .company-addr { font-size: 8.5pt; color: #475569; line-height: 1.3; }
    .doc-title-block { text-align: right; }
    .doc-label { font-size: 24pt; font-weight: 900; color: #1e293b; letter-spacing: -1px; }
    .doc-id { font-size: 11pt; color: #64748b; margin-top: 5px; font-family: monospace; }
    .info-grid { width: 100%%; margin-bottom: 12px; }
    .info-label { font-size: 7.5pt; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .info-val { font-size: 11pt; font-weight: 600; color: #1e293b; }
    .supplier-box { background: #f8fafc; padding: 12px; border-radius: 4px; border-left: 4px solid #cbd5e1; }
    .data-table { width: 100%%; border-collapse: collapse; margin-bottom: 16px; table-layout: fixed; }
    .data-table th { background-color: #1e293b; color: #fff; padding: 6px 8px; font-size: 8.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; text-align: center; }
    .data-table td { border-bottom: 1px solid #e2e8f0; font-size: 9pt; color: #334155; padding: 3px 4px; height: 21px; }
    .footer-wrap { border-top: 1px solid #e2e8f0; padding-top: 8px; margin-top: 12px; }
    .notes-title { font-size: 8.5pt; font-weight: 700; color: #7E9C76; margin-bottom: 4px; text-transform: uppercase; }
    .notes-list { margin: 0; padding-left: 15px; font-size: 8pt; color: #475569; }
    .notes-list li { margin-bottom: 2px; }
    .contact-pill { background: #eff3ee; color: #556b50; padding: 3px 6px; border-radius: 4px; font-weight: 600; font-size: 7.5pt; }
</style></head>
<body><div class="page-root">

  <div class="header-wrap">
    <table class="header-table"><tr>
      <td width="60%%">
        %s
        <div style="margin-top:8px;">
          <div class="company-name">Pet Universe Starlight</div>
          <div class="company-sub">Veterinary Medical Centre</div>
          <div class="company-addr">No 30, Jalan Sulaiman 1, Taman Ampang Hilir,<br>68000 Ampang Jaya, Selangor</div>
        </div>
      </td>
      <td width="40%%" class="doc-title-block">
        <div class="doc-label">RFQ</div>
        <div class="doc-id"># %s</div>
        <div style="margin-top:8px; font-size:9pt; color:#64748b;">Date Issued: <strong style="color:#1e293b;">%s</strong></div>
      </td>
    </tr></table>
  </div>

  <table class="info-grid"><tr>
    <td width="55%%" style="vertical-align:top;">
      <div class="supplier-box">
        <div class="info-label">To Supplier</div>
        <div class="info-val" style="font-size:12pt;">%s</div>
        <div style="font-size:9pt; color:#64748b; margin-top:4px;">Vendor Request</div>
      </div>
    </td>
    <td width="5%%"></td>
    <td width="40%%" style="vertical-align:top; padding-top:5px;">
      <div class="info-label">Valid Until</div>
      <div class="info-val">7 Business Days</div>
      <div style="margin-top:12px;"><div class="info-label">Department</div><div class="info-val">Procurement</div></div>
    </td>
  </tr></table>

  <table class="data-table">
    <thead><tr>
      <th width="8%%">#</th><th width="20%%">Stock ID</th><th width="42%%" style="text-align:left; padding-left:10px;">Item Description</th><th width="15%%">UOM</th><th width="15%%">Qty Req.</th>
    </tr></thead>
    <tbody>%s</tbody>
  </table>

  <div class="footer-wrap">
    <div class="notes-title">Important Notes</div>
    <ul class="notes-list">
      <li>This is a Request for Quotation only, not a Purchase Order.</li>
      <li>Please allow a validity period of at least 7 days for your quotation.</li>
      <li>If we do not receive a response within 7 business days, we may proceed with alternative suppliers.</li>
    </ul>
    <div style="margin-top:8px; font-size:8.5pt; color:#64748b;">
      Questions? Contact the Procurement Officer:
      <span class="contact-pill">017-2786373</span> or <span class="contact-pill">procurement@starlight-vet.com.my</span>
    </div>
  </div>

</div></body></html>`,
		logoImg, rfqID, dispDate, supName, itemRows.String(),
	)
}

// GeneratePDF writes html to a PDF at outputPath.
// Tries wkhtmltopdf first, then Chrome headless.
func GeneratePDF(html, outputPath string) error {
	htmlFile, err := os.CreateTemp("", "procura-pdf-*.html")
	if err != nil {
		return fmt.Errorf("temp file: %w", err)
	}
	defer os.Remove(htmlFile.Name())
	if _, err := htmlFile.Write([]byte(html)); err != nil {
		htmlFile.Close()
		return err
	}
	htmlFile.Close()

	// Try wkhtmltopdf first (lighter, common on VPS)
	if wk, _ := exec.LookPath("wkhtmltopdf"); wk != "" {
		cmd := exec.Command(wk,
			"--page-size", "A4",
			"--margin-top", "12.7mm",
			"--margin-bottom", "12.7mm",
			"--margin-left", "12.7mm",
			"--margin-right", "12.7mm",
			"--print-media-type",
			"--no-stop-slow-scripts",
			"--enable-local-file-access",
			htmlFile.Name(), outputPath,
		)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("wkhtmltopdf: %w — %s", err, stderr.String())
		}
		if stat, err := os.Stat(outputPath); err != nil || stat.Size() == 0 {
			return fmt.Errorf("wkhtmltopdf: empty output")
		}
		return nil
	}

	// Fallback: Chrome headless
	chromePath := findChrome()
	if chromePath == "" {
		return fmt.Errorf("no PDF renderer found — install wkhtmltopdf or chromium-browser")
	}
	cmd := exec.Command(chromePath,
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--print-to-pdf="+outputPath,
		"--print-to-pdf-no-header",
		"file://"+htmlFile.Name(),
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("chrome: %w — %s", err, stderr.String())
	}
	if _, err := os.Stat(outputPath); err != nil {
		return fmt.Errorf("pdf not created: %w", err)
	}
	return nil
}

func findChrome() string {
	for _, p := range []string{
		"google-chrome",
		"chromium-browser",
		"chromium",
		"google-chrome-stable",
	} {
		if _, err := exec.LookPath(p); err == nil {
			return p
		}
	}
	return ""
}

// Helpers

func fmtDate(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 10 {
		s = s[:10]
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s[:min(len(s), 19)]); err == nil {
			return t.Format("02/01/2006")
		}
	}
	return s
}

func fmtMoney(v float64) string {
	return fmt.Sprintf("RM %.2f", v)
}

func fmtQty(v float64) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.4f", v), "0"), ".")
}

func toFloat(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
