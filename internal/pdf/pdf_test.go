package pdf

import (
	"fmt"
	"strings"
	"testing"
)

func TestRenderRFQHTMLSupports20Items(t *testing.T) {
	items := make([]map[string]interface{}, 20)
	for i := range items {
		items[i] = map[string]interface{}{"item_name": fmt.Sprintf("Item %d", i+1), "qty": 1}
	}

	html := RenderRFQHTML("RFQ-092026-01", "2026-09-10", "Acme", items, "")
	if !strings.Contains(html, "Item 20") {
		t.Fatal("RFQ HTML omitted the 20th item")
	}
}
