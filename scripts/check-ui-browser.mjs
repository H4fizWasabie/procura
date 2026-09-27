// Actual authenticated Chrome checks against the isolated server started by check-ui-defects.py.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'procura-browser-'));
const chrome=spawn('google-chrome',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws, send;
try {
 let port;
 for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{await delay(100)}}
 assert.ok(port,'Chrome did not start');
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
 let id=0;const pending=new Map();const errors=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description||''))});
 send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
 await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
 await send('Network.setExtraHTTPHeaders',{headers:{Authorization:'Bearer '+process.env.CHECK_TOKEN}});
 await send('Network.setCookie',{name:'token',value:process.env.CHECK_TOKEN,url:process.env.CHECK_URL,httpOnly:true});
 const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const wait=async expression=>{for(let i=0;i<100;i++){if(await run(expression))return;await delay(100)}throw Error('Timed out: '+expression)};
 const navigate=async route=>{await send('Page.navigate',{url:process.env.CHECK_URL+route});await wait('location.pathname === '+JSON.stringify(route)+' && document.readyState === "complete"');};
 await navigate('/items');await wait('document.querySelector("#items-body tr") !== null');
 await run('document.getElementById("f-supplier").value="Target"; loadPage(1)');await wait('document.querySelectorAll("#items-body tr").length === 2');
 assert.equal(await run('document.getElementById("next-btn").disabled'),true);
 await run('showDetail("I001")');await wait('document.getElementById("detail-panel").style.display !== "none"');
 await run('document.getElementById("ae-cost").value="7.5"; saveAnchors()');await wait('document.getElementById("toast").textContent === "Saved"');
 await run('showDetail("I001")');await wait('document.getElementById("ae-cost").value === "7.5"');
 await run('showDetail("I002")');await wait('document.getElementById("ae-pack").value === "12"');assert.equal(await run('document.getElementById("ae-exclude").checked'),true);
 await run('document.getElementById("ae-cost").value="8"; saveAnchors()');await wait('document.getElementById("ae-cost").value === "8"');
 assert.equal(await run('document.getElementById("ae-pack").value'),'12');assert.equal(await run('document.getElementById("ae-exclude").checked'),true);
 console.log('PASS: authenticated inventory filter and edit reload preserve anchors in Chrome');
 await navigate('/pos');await wait('allPos.length > 0');
 for (const [width,height] of [[1440,900],[390,844]]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<720});
  await run('allPos=Array.from({length:60},(_,i)=>({...allPos[0],po_id:"SCROLL-"+i}));renderPoList();sizePoList()');
  const before=await run('[document.querySelector("#po-head th").getBoundingClientRect().top,document.getElementById("search").getBoundingClientRect().top]');
  await run('document.getElementById("po-list-scroll").scrollTop=500');
  const after=await run('[document.querySelector("#po-head th").getBoundingClientRect().top,document.getElementById("search").getBoundingClientRect().top]');
  assert.ok(await run('document.getElementById("po-list-scroll").scrollTop>0'));
  assert.ok(Math.abs(before[0]-after[0])<2,'PO headings moved while scrolling');
  assert.equal(before[1],after[1],'PO filters moved while scrolling');
  assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'PO page overflows horizontally');
 }
 await send('Emulation.clearDeviceMetricsOverride');
 console.log('PASS: desktop/mobile PO list scroll keeps filters and column headings visible');
 await navigate('/movement');await wait('document.getElementById("movement-header").children.length>0');
 await run('(async()=>{const originalMovementFetch=window.fetch; window.fetch=(url,...args)=>String(url).startsWith("/api/movement?")?Promise.resolve({json:()=>Promise.resolve(Array.from({length:100},(_,i)=>({stock_id:"M"+i,item_name:"Movement "+i,year:2026,month:1,in_qty:1,out_qty:0,adj_in:0,adj_out:0,report_closing:1})))}):originalMovementFetch(url,...args); document.getElementById("m-year").value="2026"; document.getElementById("m-month").value="1"; await loadMovements(); window.fetch=originalMovementFetch; sizeMovementList()})()');
 for (const [width,height] of [[1440,900],[390,844]]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<720});
  await run('sizeMovementList()');
  const before=await run('[document.querySelector("#movement-header th").getBoundingClientRect().top,document.querySelector(".search-bar").getBoundingClientRect().top]');
  await run('document.getElementById("movement-list").scrollTop=500');
  const after=await run('[document.querySelector("#movement-header th").getBoundingClientRect().top,document.querySelector(".search-bar").getBoundingClientRect().top]');
  assert.ok(await run('document.getElementById("movement-list").scrollTop>0'));
  assert.ok(Math.abs(before[0]-after[0])<2,'Movement headings moved while scrolling: '+before[0]+' to '+after[0]+' ('+await run('getComputedStyle(document.querySelector("#movement-header th")).position+" / "+getComputedStyle(document.getElementById("movement-list")).overflowY')+')');
  assert.equal(before[1],after[1],'Movement filters moved while scrolling');
  assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'Movement page overflows horizontally');
 }
 await send('Emulation.clearDeviceMetricsOverride');
 console.log('PASS: desktop/mobile movement filters and column headings stay visible while rows scroll');
 await navigate('/pos');await wait('allPos.length > 0');
 await run("showPoView('new'); document.getElementById('npo-dept').value=''; document.getElementById('npo-supplier').value=''; window.poSaveFetches=0; window.fetch=()=>{window.poSaveFetches++; throw Error('unexpected save request')}; savePo()");
 assert.match(await run('document.getElementById("toast").textContent'),/Date|Department|Supplier/);
 assert.equal(await run('document.activeElement.id'),'npo-dept');assert.equal(await run('window.poSaveFetches'),0);
 console.log('PASS: PO header validation focuses a missing field and blocks the save request');
 await navigate('/pos');await wait('allPos.length > 0');await run('selectPo("PO-CHECK")');
 await run('document.getElementById("po-edit-ship").value="Shipped"; updatePoField("ship")');await wait('document.getElementById("toast").textContent === "Updated"');
 assert.equal(await run('allPos.find(p=>p.po_id==="PO-CHECK").status'),'Pending Approval');
 await run('document.getElementById("po-edit-status").value="Void"; updatePoField("status")');await wait('document.getElementById("toast").textContent.includes("Error")');
 assert.equal(await run('allPos.find(p=>p.po_id==="PO-CHECK").status'),'Pending Approval');
 console.log('PASS: authenticated shipment and failed status save in Chrome');
 await navigate('/workflow');await wait('wfData.length > 0');
 await run('selected=new Set(["PO-CHECK","MISSING"]); batchAction()');await wait('!document.getElementById("wf-action-btn").disabled && document.getElementById("toast").textContent.includes("failed")');
 assert.deepEqual(await run('[...selected]'),['MISSING']);assert.match(await run('document.getElementById("wf-results").textContent'),/Succeeded: PO-CHECK/);
 console.log('PASS: authenticated mixed batch retains failed selection in Chrome');
 await navigate('/reports');await run('switchTab("history"); document.getElementById("ih-search").value="Item"; searchPoItems()');
 await wait('document.querySelector("#ih-results input") !== null');await run('document.querySelector("#ih-results input").click(); document.querySelector("#ih-results input").click(); runItemHistory()');await wait('document.querySelector("#ih-body tr") !== null');
 console.log('PASS: authenticated item-history checkboxes and report in Chrome');
 await navigate('/scorecard');await wait('pendingList.length > 0');
 await run('openRate("PO-SCORE","Supplier","BILL"); document.getElementById("rm-comment").value="Browser note"; submitScore()');await wait('document.getElementById("toast").textContent === "Score saved"');await wait('document.getElementById("sc-summary").textContent.includes("Supplier")');
 console.log('PASS: authenticated scorecard save and summary in Chrome');
 await navigate('/rfq');await wait('suppliers.length > 0');await run('openCreate()');await wait('document.getElementById("create-modal").classList.contains("open")');
 await run('document.getElementById("c-supplier").value="Supplir"; searchSuppliers()');assert.equal(await run('supplierMatches.includes("Supplier")'),true);
 await run('document.getElementById("c-supplier").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})); document.getElementById("c-supplier").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');assert.equal(await run('selectedSupplier'),'Supplier');
 await run('document.getElementById("c-supplier").value="oth"; searchSuppliers(); document.querySelector(".rfq-supplier-option").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');assert.equal(await run('selectedSupplier'),'Other');
 await run('document.getElementById("c-supplier").value="zzzz"; searchSuppliers()');assert.equal(await run('document.getElementById("rfq-supplier-options").hidden'),true);assert.match(await run('document.getElementById("rfq-supplier-status").textContent'),/No matching/);
 await run('document.getElementById("c-supplier").value="No such supplier"; searchSuppliers(); window.rfqSaveFetches=0; const originalFetch=window.fetch; window.fetch=(...args)=>{if(args[0]==="/api/rfq")window.rfqSaveFetches++;return originalFetch(...args)}; saveRFQ()');assert.equal(await run('window.rfqSaveFetches'),0);assert.match(await run('document.getElementById("rfq-supplier-status").textContent'),/Select a supplier/);
 await run('document.getElementById("c-supplier").value="Supplir"; searchSuppliers(); supplierActive=0; setSupplier(supplierMatches[0]); saveRFQ()');await wait('rfqData.some(r=>r.supplier==="Supplier")');
 const savedRFQ=await run('rfqData.find(r=>r.supplier==="Supplier").rfq_id');await run('editRFQ('+JSON.stringify(savedRFQ)+')');assert.equal(await run('selectedSupplier'),'Supplier');assert.equal(await run('document.getElementById("c-supplier").value'),'Supplier');
 console.log('PASS: RFQ supplier typo matching, keyboard selection, unmatched rejection, save and edit reload in Chrome');
 assert.deepEqual(errors,[],errors.join('\n'));
} finally {
 if(send && ws.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} }
 if(ws)ws.close();
 if(chrome.exitCode === null) { chrome.kill(); await new Promise(r=>chrome.once('exit',r)); }
 await delay(500);
 fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
