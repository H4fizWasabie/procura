// GS_Report.js

// Cache for Items data (5 minute TTL)
const REPORT_CACHE_KEY = 'report_items_cache';
const REPORT_CACHE_TTL = 300; // 5 minutes in seconds

/**
 * Gets cached items data or fetches fresh if cache expired
 */
function getCachedItemsMap() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(REPORT_CACHE_KEY);
    
    if (cached) {
      console.log("Using cached items data");
      return JSON.parse(cached);
    }
  } catch (e) {
    console.warn("Cache read failed, fetching fresh:", e.message);
  }
  
  // Fetch fresh data
  console.log("Fetching fresh items data");
  const ss = getSpreadsheet();
  const dbItems = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS).getDataRange().getValues();
  const itemsHeaderMap = getHeaderMap(dbItems[0]);
  
  const itemsMap = {};
  for (let i = 1; i < dbItems.length; i++) {
    const row = dbItems[i];
    if (!row[0]) continue;
    const sku = String(row[itemsHeaderMap['stock id']]).trim();
    itemsMap[sku] = {
      name: String(row[itemsHeaderMap['item name']] || ''),
      type: String(row[itemsHeaderMap['product type']] || ''),
      category: String(row[itemsHeaderMap['category']] || ''),
      cost: parseFloat(row[itemsHeaderMap['cost']]) || 0,
      current: parseFloat(row[itemsHeaderMap['current']]) || 0,
      rop: parseFloat(row[itemsHeaderMap['rop']]) || 0
    };
  }
  
  // Cache the result
  try {
    const cache = CacheService.getScriptCache();
    cache.put(REPORT_CACHE_KEY, JSON.stringify(itemsMap), REPORT_CACHE_TTL);
  } catch (e) {
    console.warn("Cache write failed:", e.message);
  }
  
  return itemsMap;
}

/**
 * Generates an itemized report for a specific metric, year, and month.
 * @param {string} metricType 'closing_stock', 'consumption', 'restock'
 * @param {number} year e.g. 2026
 * @param {number} month 1-12
 * @param {number} page Page number (default: 1)
 * @param {number} pageSize Items per page (default: 50)
 */
/**
 * Normalize item name for matching (handle O↔0, I↔1 typos)
 */
function _normalizeName(name) {
  return String(name || '').toUpperCase()
    .replace(/O/g, '0')
    .replace(/[Il]/g, '1');
}

/**
 * Extract core item name tokens (drug/product name without dosage, form, packaging)
 * Returns a Set of clean tokens for fuzzy comparison
 */
function _extractCoreTokens(name) {
  const FORM_WORDS = ['inj','tab','cap','sol','cream','oint','susp','syrup','drop','vial',
    'box','btl','sachet','amp','ampul','gel','lotion','powder','spray','ointment','paste',
    'solution','suspension', 'nebul', 'infusion', 'bottle'];
  const UNIT_WORDS = ['unit', 'pcs', 'pc', 'box', 'strip', 'pack', 'bottle', 'vial'];
  const DOSAGE_UNITS = ['mg', 'ml', 'g', 'kg', '%', 'iu', 'mcg', 'iu'];
  
  // Common typos normalization: O→0, I/l→1
  let cleaned = String(name || '').toUpperCase()
    .replace(/O/g, '0')        // O → 0
    .replace(/[Il]/g, '1');    // I, l → 1
  
  // Remove parenthetical content and everything inside brackets
  cleaned = cleaned.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  
  // Remove dosage patterns: 40MG, 40 MG, 500ML, 2.5%, 100'S, 1S
  cleaned = cleaned.replace(/\d+\.?\d*\s*(?:MG|ML|G|KG|\%|IU|MCG)\b/g, ' ');
  cleaned = cleaned.replace(/\d+\.?\d*%/g, ' ');
  cleaned = cleaned.replace(/\d+\s*'?\s*S\b/g, ' ');  // pack sizes like 50'S, 1S
  
  // Remove form/type words
  cleaned = cleaned.replace(new RegExp('\\b(?:' + FORM_WORDS.join('|') + ')\\S*\\b', 'g'), ' ');
  
  // Remove "FOR INFUSION", "FOR INJECTION" etc
  cleaned = cleaned.replace(/\bFOR\s+\w+\b/g, ' ');
  
  // Remove remaining special chars and collapse spaces
  cleaned = cleaned.replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Split into tokens and filter out known filler words and dosage unit tokens
  const tokens = cleaned.split(/\s+/).filter(t => 
    t.length > 0 && 
    !DOSAGE_UNITS.includes(t.toLowerCase()) &&
    !UNIT_WORDS.includes(t.toLowerCase()) &&
    !/^\d+$/.test(t)  // Pure numeric tokens (leftover from dosage removal)
  );
  
  return new Set(tokens);
}

/**
 * Calculate fuzzy match score between two name token sets
 * Returns score 0-100 (higher = better match)
 */
function _fuzzyNameScore(tokensA, tokensB) {
  if (!tokensA.size || !tokensB.size) return 0;
  
  // Count exact overlapping tokens
  let exactOverlap = 0;
  tokensA.forEach(token => {
    if (tokensB.has(token)) exactOverlap++;
  });
  
  // CRITICAL: Require at least one exact shared word to prevent false matches
  // This prevents "PANTOCID" from matching "Trilostane" which share no common words
  if (exactOverlap === 0) return 0;
  
  // Count partial overlaps (prefix matching)
  let partialOverlap = 0;
  if (exactOverlap === 0) {
    tokensA.forEach(tokenA => {
      tokensB.forEach(tokenB => {
        if (tokenA.startsWith(tokenB) || tokenB.startsWith(tokenA)) {
          partialOverlap += 0.5;
        }
      });
    });
  }
  
  const totalOverlap = exactOverlap + partialOverlap;
  const unionSize = new Set([...tokensA, ...tokensB]).size;
  if (unionSize === 0) return 0;
  
  const overlapRatio = totalOverlap / unionSize;
  const minSize = Math.min(tokensA.size, tokensB.size);
  const sizeBonus = Math.min(minSize / 3, 1);
  
  return Math.round((overlapRatio * 50 + sizeBonus * 50) * 100) / 100;
}

/**
 * Search PO history for item entries - for dropdown in Item History Report
 * Returns PO items sorted by date (newest first), each with PO number, qty, date, cost
 */
function apiGetPOItemSearch(query) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  
  if (!query || String(query).trim().length < 1) {
    return [];
  }
  
  const ss = getSpreadsheet();
  const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  if (!poSheet) return [];
  
  const poData = poSheet.getDataRange().getValues();
  const poHeaders = poData[0];
  const idxPoId = poHeaders.indexOf('PO ID');
  const idxPoDate = poHeaders.indexOf('Date');
  const idxPoJson = poHeaders.indexOf('PO_Data_JSON');
  const idxPoSupplier = poHeaders.indexOf('Supplier');
  
  const searchLower = String(query).toLowerCase().trim();
  const searchWords = searchLower.split(/\s+/).filter(w => w.length > 0);
  
  const results = [];
  
  for (let i = 1; i < poData.length; i++) {
    const row = poData[i];
    const poId = String(row[idxPoId] || '').trim();
    if (!poId) continue;
    
    let poDate = row[idxPoDate];
    if (poDate instanceof Date) {
      poDate = poDate.toISOString().split('T')[0];
    }
    const poSupplier = String(row[idxPoSupplier] || '');
    
    let poItems = [];
    try {
      poItems = JSON.parse(row[idxPoJson] || '[]');
    } catch (e) { continue; }
    
    for (const item of poItems) {
      const poName = String(item.n || item.name || '').trim();
      if (!poName) continue;
      
      // Score this item against search query
      let score = 0;
      const nameLower = poName.toLowerCase();
      
      // Exact name match
      if (nameLower === searchLower) { score = 1000; }
      // Name contains full query
      else if (nameLower.includes(searchLower)) { score = 500; }
      // Word-based match
      else {
        for (const word of searchWords) {
          if (nameLower.includes(word)) score += 50;
        }
      }
      
      // Also search by PO ID
      if (poId.toLowerCase().includes(searchLower)) { score = 200; }
      
      if (score > 0) {
        const poQty = (typeof item.q === 'string') ? parseFloat(item.q) : (item.q || 0);
        const poCost = (typeof item.c === 'string') ? parseFloat(item.c) : (item.c || 0);
        
        results.push({
          name: poName,
          poId: poId,
          date: poDate,
          qty: isNaN(poQty) ? 0 : poQty,
          cost: isNaN(poCost) ? 0 : poCost,
          supplier: poSupplier,
          score: score
        });
      }
    }
  }
  
  // Sort by date descending (newest first), then by score
  results.sort((a, b) => {
    const dateCompare = (b.date || '').localeCompare(a.date || '');
    if (dateCompare !== 0) return dateCompare;
    return b.score - a.score;
  });
  
  return results.slice(0, 30); // Return top 30 results
}

/**
 * Generate Item History Report
 * Shows last purchase date and quantity for selected items
 * @param {Array} items - Array of objects {id, name} to include in report
 * @returns {Object} Report data with last buy info for each item
 */
function apiGenerateItemHistoryReport(items) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { success: false, error: 'No items selected.' };
  }
  
  const FUZZY_THRESHOLD = 30; // Minimum score to consider a match
  
  try {
    const ss = getSpreadsheet();
    
    // 1. Get item details from DB_Items
    const itemsSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
    const itemsMap = {};
    const itemsByName = {}; // Map by normalized name for cross-reference
    
    if (itemsSheet) {
      const itemsData = itemsSheet.getDataRange().getValues();
      const itemsHeaders = itemsData[0];
      const idxStockId = itemsHeaders.indexOf('Stock ID');
      const idxItemName = itemsHeaders.indexOf('Item Name');
      const idxSupplier = itemsHeaders.indexOf('Supplier');
      const idxUom = itemsHeaders.indexOf('UOM');
      
      for (let i = 1; i < itemsData.length; i++) {
        const row = itemsData[i];
        const sku = String(row[idxStockId] || '').trim();
        const itemName = String(row[idxItemName] || '').trim();
        if (sku) {
          itemsMap[sku] = {
            name: itemName,
            supplier: idxSupplier > -1 ? String(row[idxSupplier] || '') : '',
            uom: idxUom > -1 ? String(row[idxUom] || '') : 'UNIT'
          };
          // Also index by normalized name
          const normName = _normalizeName(itemName);
          if (normName) itemsByName[normName] = sku;
        }
      }
    }
    
    // 2. Get PO history to find last purchase
    const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
    if (!poSheet) return { success: false, error: 'PO sheet not found.' };
    
    const poData = poSheet.getDataRange().getValues();
    const poHeaders = poData[0];
    const idxPoId = poHeaders.indexOf('PO ID');
    const idxPoDate = poHeaders.indexOf('Date');
    const idxPoJson = poHeaders.indexOf('PO_Data_JSON');
    const idxPoSupplier = poHeaders.indexOf('Supplier');
    
    // Build a list of all PO items with pre-computed tokens
    const allPoItems = [];
    for (let i = 1; i < poData.length; i++) {
      const row = poData[i];
      const poId = String(row[idxPoId] || '').trim();
      if (!poId) continue;
      
      let poDate = row[idxPoDate];
      if (poDate instanceof Date) {
        poDate = poDate.toISOString().split('T')[0];
      }
      const poSupplier = String(row[idxPoSupplier] || '');
      
      let poItems = [];
      try {
        poItems = JSON.parse(row[idxPoJson] || '[]');
      } catch (e) { continue; }
      
      poItems.forEach(item => {
        const poName = String(item.n || item.name || '').trim();
        if (!poName) return;
        
        const poItemId = String(item.id || '').trim();
        const poQty = (typeof item.q === 'string') ? parseFloat(item.q) : (item.q || 0);
        const poCost = (typeof item.c === 'string') ? parseFloat(item.c) : (item.c || 0);
        const poTotal = (typeof item.t === 'string') ? parseFloat(item.t) : (item.t || 0);
        
        allPoItems.push({
          id: poItemId,
          name: poName,
          qty: isNaN(poQty) ? 0 : poQty,
          cost: isNaN(poCost) ? 0 : poCost,
          total: isNaN(poTotal) ? 0 : poTotal,
          uom: String(item.u || item.uom || 'UNIT').trim(),
          poId: poId,
          date: poDate,
          supplier: poSupplier,
          nameTokens: _extractCoreTokens(poName),       // Pre-compute tokens
          nameNorm: _normalizeName(poName),             // Pre-compute normalized
        });
      });
    }
    
    // 3. For each requested item, find ALL matching PO history entries
    const reportData = [];
    
    items.forEach(requestedItem => {
      const reqId = String(requestedItem.id || '').trim();
      const reqName = String(requestedItem.name || '').trim();
      
      if (!reqId && !reqName) return;
      
      // Get item metadata - try by ID first, then by name lookup
      let itemMeta = itemsMap[reqId] || null;
      
      // If not found by ID, try to find by name
      if (!itemMeta && reqName) {
        const reqNormName = _normalizeName(reqName);
        for (const [normKey, sku] of Object.entries(itemsByName)) {
          if (normKey === reqNormName || normKey.includes(reqNormName) || reqNormName.includes(normKey)) {
            itemMeta = itemsMap[sku];
            break;
          }
        }
      }
      
      if (!itemMeta) {
        itemMeta = { name: reqName, supplier: '', uom: 'UNIT' };
      }
      
      // Collect ALL matching PO entries for this item
      let matches = [];
      const reqTokens = _extractCoreTokens(reqName);
      const reqNorm = _normalizeName(reqName);
      
      for (const poItem of allPoItems) {
        let score = 0;
        let matchStrategy = '';
        
        // Strategy 1: Exact ID match (highest priority)
        if (reqId && poItem.id && poItem.id.toUpperCase() === reqId.toUpperCase()) {
          score = 100;
          matchStrategy = 'id_exact';
        }
        // Strategy 2: PO item ID matches requested name (cross-reference)
        else if (reqName && poItem.id && _normalizeName(poItem.id).includes(_normalizeName(reqName).substring(0, 10))) {
          score = 50;
          matchStrategy = 'id_name';
        }
        // Strategy 3: Token-based fuzzy name matching
        else if (reqTokens.size > 0 && poItem.nameTokens.size > 0) {
          score = _fuzzyNameScore(reqTokens, poItem.nameTokens);
          
          // Boost score if normalized names have significant overlap
          if (poItem.nameNorm.includes(reqNorm) || reqNorm.includes(poItem.nameNorm)) {
            score = Math.max(score, 70);  // Guarantee match for substring
          }
          
          if (score >= FUZZY_THRESHOLD) {
            matchStrategy = 'fuzzy_' + score;
          } else {
            score = 0;  // Below threshold, don't count
          }
        }
        // Strategy 4: Normalized substring matching (fallback)
        else if (reqNorm && poItem.nameNorm) {
          if (poItem.nameNorm.includes(reqNorm) || reqNorm.includes(poItem.nameNorm)) {
            score = 60;
            matchStrategy = 'substring';
          }
        }
        
        if (score > 0) {
          matches.push({
            ...poItem,
            score: score,
            strategy: matchStrategy
          });
        }
      }
      
      // Sort by date descending (most recent first)
      matches.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      
      const mostRecent = matches[0] || null;   // Current/latest purchase
      
      // Find the previous (second most recent) purchase
      let previousPurchase = null;
      if (matches.length > 1) {
        for (let i = 1; i < matches.length; i++) {
          if (matches[i].date < mostRecent.date) {
            previousPurchase = matches[i];
            break;
          }
        }
        // If all same date, just take second entry
        if (!previousPurchase && matches.length > 1) {
          previousPurchase = matches[1];
        }
      }
      
      reportData.push({
        stockId: reqId || itemMeta.supplier || '(no ID)',
        itemName: itemMeta.name || reqName,
        supplier: itemMeta.supplier || (mostRecent ? mostRecent.supplier : ''),
        uom: itemMeta.uom || 'UNIT',
        lastPoId: mostRecent ? mostRecent.poId : 'N/A',
        lastBuyDate: previousPurchase ? previousPurchase.date : 'Never',
        lastBuyQty: mostRecent ? mostRecent.qty : 0,
        matchedName: mostRecent ? mostRecent.name : '',
        totalMatches: matches.length,  // How many PO entries matched
        matchStrategy: mostRecent ? mostRecent.strategy : 'none'
      });
    });
    
    return { success: true, data: reportData };
    
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function apiGenerateMetricReport(metricType, year, month, page, pageSize) {
  try {
    assertPermission(['ADMIN', 'EDITOR', 'VIEWER']);
    
    // Set pagination defaults
    page = page || 1;
    pageSize = pageSize || 50;
    
    const ss = getSpreadsheet();
    
    // 1. Get cached Items Map
    const itemsMap = getCachedItemsMap();

    const reportData = [];
    
    // For 'restock', it's purely current state, ignore month/year
    if (metricType === 'restock') {
      for (const [sku, meta] of Object.entries(itemsMap)) {
        if (meta.rop > 0 && meta.current < meta.rop) {
          const qtyGap = meta.rop - meta.current;
          const totalVal = qtyGap * meta.cost;
          if (qtyGap > 0) {
            reportData.push({
              sku: sku,
              name: meta.name,
              type: meta.type,
              category: meta.category,
              qty: qtyGap,
              cost: meta.cost,
              totalValue: totalVal
            });
          }
        }
      }
      reportData.sort((a, b) => b.totalValue - a.totalValue);
      
      // Apply pagination
      const totalItems = reportData.length;
      const totalPages = Math.ceil(totalItems / pageSize);
      const startIndex = (page - 1) * pageSize;
      const endIndex = Math.min(startIndex + pageSize, totalItems);
      const paginatedData = reportData.slice(startIndex, endIndex);
      
      return { 
        success: true, 
        data: paginatedData,
        pagination: {
          page: page,
          pageSize: pageSize,
          totalItems: totalItems,
          totalPages: totalPages
        }
      };
    }
    
    // For historical metrics, we need the Movement sheet
    const movSheetName = `Movement ${year}`;
    const movSheet = ss.getSheetByName(movSheetName);
    
    if (!movSheet) {
      return { error: `No movement data found for ${year} (Sheet '${movSheetName}' missing).` };
    }
    
    // Get all data from Movement sheet (same as original)
    const movData = movSheet.getDataRange().getValues();
    const mIndex = month - 1; // 0 for Jan, 11 for Dec
    const base = 2 + (mIndex * 5); // 2, 7, 12, 17... (column index for this month)
    
    // Start from row 2 (index 2, so 3rd row, skipping headers) - same as original
    for (let i = 2; i < movData.length; i++) {
      const row = movData[i];
      const sku = String(row[0]).trim();
      if (!sku || !itemsMap[sku]) continue;
      
      const meta = itemsMap[sku];
      let qty = 0;
      
      if (metricType === 'closing_stock') {
        qty = parseFloat(row[base + 4]) || 0; // REPORT CLOSING
      } else if (metricType === 'consumption') {
        const out = parseFloat(row[base + 1]) || 0;
        const adjOut = parseFloat(row[base + 3]) || 0;
        qty = out + adjOut;
      }
      
      if (qty > 0) {
        const totalVal = qty * meta.cost;
        reportData.push({
          sku: sku,
          name: meta.name,
          type: meta.type,
          category: meta.category,
          qty: qty,
          cost: meta.cost,
          totalValue: totalVal
        });
      }
    }
    
    // Sort descending by total value
    reportData.sort((a, b) => b.totalValue - a.totalValue);
    
    // Calculate totals for ALL data (not just current page)
    let totalQty = 0;
    let totalValue = 0;
    reportData.forEach(item => {
      totalQty += item.qty || 0;
      totalValue += item.totalValue || 0;
    });
    
    // Apply pagination
    const totalItems = reportData.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalItems);
    const paginatedData = reportData.slice(startIndex, endIndex);
    
    return { 
      success: true, 
      data: paginatedData,
      pagination: {
        page: page,
        pageSize: pageSize,
        totalItems: totalItems,
        totalPages: totalPages
      },
      totals: {
        totalQty: totalQty,
        totalValue: totalValue
      }
    };
    
  } catch (err) {
    console.error("Report Error:", err);
    return { error: err.message };
  }
}

