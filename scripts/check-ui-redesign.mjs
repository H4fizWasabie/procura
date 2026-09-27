// Authenticated redesign checks against the isolated local sample workspace.
// CHECK_URL/CHECK_EMAIL/CHECK_PIN can target another disposable seeded workspace.
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
 const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const wait=async expression=>{for(let i=0;i<100;i++){if(await run(expression))return;await delay(100)}throw Error('Timed out: '+expression)};
 const navigate=async route=>{await send('Page.navigate',{url:(process.env.CHECK_URL || "http://localhost:8766")+route});await wait('location.pathname+location.search === '+JSON.stringify(route)+' && document.readyState === "complete"');};
 const base=process.env.CHECK_URL || 'http://localhost:8766';
 const email=process.env.CHECK_EMAIL || 'admin@preview.local';
 const pin=process.env.CHECK_PIN || '246810';
 await send('Page.navigate',{url:base+'/login'});await wait('document.readyState === "complete" && location.pathname === "/login"');
 const login=await run(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(email)},pin:${JSON.stringify(pin)}})}).then(async r => ({status:r.status,data:await r.json()}))`);
 assert.equal(login.status,200);assert.equal(login.data.success,true);
 const routes=['/','/pos','/items','/planning','/rfq','/suppliers','/catalogue','/workflow','/tasks','/movement','/reports','/analytics','/scorecard','/uom','/import','/validation','/users','/pos/unlinked'];
 for(const route of routes) {
  await navigate(route);await delay(700);
  assert.equal(await run('document.querySelectorAll(".primary-nav>a").length'),5,route);
  assert.equal(await run('document.querySelector("main").children.length > 0'),true,route);
  const active=await run('document.querySelector(".side-nav a[aria-current=page]")?.getAttribute("href")');
  assert.equal(active,route==='/pos/unlinked'?'/pos':route,route);
 }
 console.log('PASS: all 18 operational pages render with complete navigation and active workspace');
 await navigate('/');
 assert.deepEqual(await run('Array.from(document.querySelectorAll(".priority-actions a"),a=>a.getAttribute("href"))'),['/pos','/items','/planning','/rfq']);
 assert.equal(await run('document.querySelectorAll(".overview-metrics>.card").length'),6);
 console.log('PASS: Overview retains six metrics with priority tasks above them');
 await navigate('/pos');await wait('allPos.length > 0');
 await run('document.getElementById("show-invoice-number").checked=false; document.getElementById("show-invoice-date").checked=false; renderPoList()');
 assert.equal(await run('document.querySelectorAll("#po-head th").length'),8);
 await run('document.getElementById("show-invoice-number").click(); document.getElementById("show-invoice-date").click()');
 assert.equal(await run('document.querySelectorAll("#po-head th").length'),10);
 await run('document.getElementById("search").value="PO-DEMO-001"; loadPos()');await wait('allPos.length===1');
 await run('document.querySelector("#po-body button").click()');await wait('poView === "detail"');
 assert.equal(await run('document.getElementById("tab-history").style.display'),'none');
 assert.equal(await run('document.querySelectorAll("#po-detail-grid>div").length'),12);
 await run('closePoDetail()');
 assert.equal(await run('document.getElementById("search").value'),'PO-DEMO-001');
 assert.equal(await run('document.querySelectorAll("#po-body tr.selected").length'),1);
 await navigate('/pos');await wait('allPos.length===1');
 assert.equal(await run('document.getElementById("search").value'),'PO-DEMO-001');
 assert.equal(await run('document.querySelectorAll("#po-head th").length'),10);
 await run('selectPo("PO-DEMO-001")');await wait('poView === "detail"');
 await run('document.getElementById("po-edit-invdate").value="27/09/2026"; updatePoField("invdate")');await wait('selectedPo.invoice_date === "2026-09-27"');
 await run('document.getElementById("po-edit-invdate").value=""; updatePoField("invdate")');await wait('!selectedPo.invoice_date');
 await run('editSelectedPo(); document.getElementById("npo-bill").value="Unsaved note"; updatePoEditState()');
 assert.equal(await run('poFormChanged()'),true);
 await run('window.confirm=()=>false; switchTab("history")');assert.equal(await run('poView'),'new');
 await run('window.confirm=()=>true; switchTab("history")');assert.equal(await run('poView'),'history');
 console.log('PASS: PO columns, complete details, back/reload context, invoice set/clear and unsaved protection');
 await run('resetPoFilters()');await wait('allPos.length>1');
 await run('switchTab("new"); document.getElementById("npo-supplier").value="Northstar Medical"; document.getElementById("npo-supplier").dispatchEvent(new Event("change")); document.getElementById("npo-item-search").value="DEMO-001"; renderPoSuggestions()');
 await run('document.getElementById("npo-item-search").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})); document.getElementById("npo-item-search").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
 assert.match(await run('document.getElementById("npo-item-search").value'),/Nitrile/);
 assert.equal(await run('document.getElementById("npo-sup-uom").value'),'box');
 const orderId='PO-UI-'+Date.now();
 await run(`document.getElementById('npo-id').value=${JSON.stringify(orderId)}; document.getElementById('npo-dept').value='Pharmacy'; document.getElementById('npo-qty').value='2';document.getElementById('npo-line-total').value='37'; addPoItem(); savePo()`);
 await wait(`allPos.some(p => p.po_id === ${JSON.stringify(orderId)})`);
 await run(`selectPo(${JSON.stringify(orderId)})`);await wait('poView === "detail"');
 assert.equal(await run('selectedPo.total'),37);assert.equal(await run('selectedPo.items[0].supplier_uom'),'box');
 await run('editSelectedPo(); document.getElementById("npo-bill").value="UI parity "+selectedPoId; savePo()');await wait('!poFormChanged()');
 await navigate('/pos?order='+orderId);await wait('poView === "detail"');assert.equal(await run('selectedPo.bill_no'),'UI parity '+orderId);
 const files=await run(`Promise.all(['/pos/'+${JSON.stringify(orderId)}+'/preview','/pos/'+${JSON.stringify(orderId)}+'/pdf'].map(async path=>{const r=await fetch(path);return [r.status,r.headers.get('content-type'),(await r.arrayBuffer()).byteLength]}))`);
 assert.equal(files[0][0],200);assert.match(files[0][1],/html/);assert.equal(files[1][0],200);assert.match(files[1][1],/pdf/);assert.ok(files[1][2]>1000);
 console.log('PASS: keyboard item selection, supplier UOM, PO create/edit/readback and preview/PDF');
 await run('selectPo("PO-DEMO-003")');await wait('selectedPo?.po_id === "PO-DEMO-003"');
 const paidBefore=await run('[selectedPo.paid,selectedPo.balance,selectedPo.status]');
 await run('editSelectedPo(); document.getElementById("npo-bill").value="Edit retained payment "+Date.now(); savePo()');await wait('!poFormChanged()');
 await navigate('/pos?order=PO-DEMO-003');await wait('selectedPo?.po_id === "PO-DEMO-003"');
 assert.deepEqual(await run('[selectedPo.paid,selectedPo.balance,selectedPo.status]'),paidBefore);
 console.log('PASS: actual paid PO edit retains payment, outstanding balance and approval status after reload');

 await navigate('/planning');await wait('data.length>0');
 await run('toggle(data[0].id,true);createRFQ()');await wait('location.pathname === "/rfq" && document.getElementById("create-modal")?.classList.contains("open")');
 assert.equal(await run('document.querySelectorAll("#c-items tbody tr").length'),1);
 await run('document.getElementById("c-supplier").value="Northstar Medical"; document.getElementById("c-notes").value="Direction A handoff"; saveRFQ()');await wait('!document.getElementById("create-modal").classList.contains("open")');await wait('rfqData.length>0');
 const rfqId=await run('rfqData.at(-1).rfq_id');
 const rfqFiles=await run(`Promise.all(['/rfq/'+${JSON.stringify(rfqId)}+'/preview','/rfq/'+${JSON.stringify(rfqId)}+'/pdf'].map(async path=>{const r=await fetch(path);return [r.status,r.headers.get('content-type')]}))`);
 assert.equal(rfqFiles[0][0],200);assert.equal(rfqFiles[1][0],200);assert.match(rfqFiles[1][1],/pdf/);
 console.log('PASS: actual Planning selection to RFQ handoff, save, preview and PDF');
 // Screenshots use real rendered data, with the same viewports in a bounded pass.
 const output=process.env.CHECK_SCREENSHOTS || '/home/hafiz/procura-ui-preview/screenshots';fs.mkdirSync(output,{recursive:true});
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 for(const [route,name] of [['/','overview'],['/pos','orders'],['/pos?order='+orderId,'order-detail'],['/items','inventory'],['/planning','planning'],['/rfq','rfq']]) {
  await navigate(route);await delay(500);const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'-desktop.png'),Buffer.from(shot.data,'base64'));
 }
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await navigate('/pos');await delay(500);let shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'orders-mobile.png'),Buffer.from(shot.data,'base64'));
 assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'),true,'mobile page overflow');
 await run('toggleNav()');assert.equal(await run('document.querySelector(".mobile-menu").getAttribute("aria-expanded")'),'true');
 shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'navigation-mobile.png'),Buffer.from(shot.data,'base64'));
 await send('Emulation.clearDeviceMetricsOverride');
 for(const role of ['editor','viewer']) {
  await run(`fetch('/api/logout',{method:'POST'}).then(()=>fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(role+'@preview.local')},pin:${JSON.stringify(pin)}})}))`);
  await navigate('/pos');assert.equal(await run('document.querySelector(".side-nav a[href$=users]") === null'),true);
  const forbidden=await run('fetch("/users").then(r=>r.status)');assert.equal(forbidden,403);
 }
 console.log('PASS: desktop/mobile layout, navigation, and Users access for Editor/Viewer');
 await run('fetch("/api/logout",{method:"POST"}).then(()=>fetch("/api/login/demo",{method:"POST"}))');
 await navigate('/');assert.match(await run('document.querySelector(".main-shell").textContent'),/Demo workspace/);
 const demoWrite=await run('fetch("/api/tasks",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"should be rejected"})}).then(r=>r.status)');assert.equal(demoWrite,403);
 await run('logout()');await wait('location.pathname === "/login"');
 console.log('PASS: demo sample-data banner, write isolation and logout');
 assert.deepEqual(errors,[],errors.join('\n'));
} finally {
 if(send && ws.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} }
 if(ws)ws.close();
 if(chrome.exitCode === null) { chrome.kill(); await new Promise(r=>chrome.once('exit',r)); }
 await delay(500);
 fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
