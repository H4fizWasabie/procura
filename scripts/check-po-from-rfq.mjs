// Browser check for starting a PO from an RFQ; run by check-ui-defects.py with CHECK_URL and an ADMIN CHECK_TOKEN.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'procura-po-rfq-'));
const chrome=spawn('google-chrome',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws, send;
try {
 let port;
 for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{await delay(100)}}
 assert.ok(port,'Chrome did not start');
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 let id=0;const pending=new Map();
 ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id)return;const request=pending.get(message.id);pending.delete(message.id);if(message.error)request.reject(Error(message.error.message));else request.resolve(message.result)});
 send=(method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))});
 await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
 await send('Network.setExtraHTTPHeaders',{headers:{Authorization:'Bearer '+process.env.CHECK_TOKEN}});
 await send('Network.setCookie',{name:'token',value:process.env.CHECK_TOKEN,url:process.env.CHECK_URL,httpOnly:true});
 const run=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
 const wait=async expression=>{for(let i=0;i<100;i++){if(await run(expression))return;await delay(100)}throw Error('Timed out: '+expression)};
 const base=process.env.CHECK_URL;
 await send('Page.navigate',{url:base+'/pos?from_rfq=RFQ-CHECK'});await wait('location.pathname === "/pos" && document.readyState === "complete" && poRfqs.length > 0 && !document.getElementById("npo-rfq-lines").hidden');
 assert.equal(await run(`document.getElementById('npo-supplier').value`),'Target');
 assert.equal(await run(`document.querySelectorAll('#npo-rfq-lines button').length`),2);
 await run(`useRfqLine(0)`);
 assert.deepEqual(await run(`[document.getElementById('npo-item-search').value,document.getElementById('npo-qty').value,document.getElementById('npo-sup-uom').value,document.activeElement.id]`),['[I000] Item 0','3','box','npo-line-total']);
 await run(`(()=>{const dept=document.getElementById('npo-dept');dept.value=[...dept.options].find(o=>o.value).value;document.getElementById('npo-line-total').value='30';addPoItem()})()`);
 assert.match(await run(`document.querySelector('#npo-rfq-lines button').textContent`),/^✓ /);
 await run(`document.getElementById('npo-supplier').value='Other'`);
 const asked=await run(`(()=>{let msg='';window.confirm=m=>{msg=m;return true};savePo();return msg})()`);
 assert.match(asked,/RFQ-CHECK was sent to Target/);
 await wait(`document.getElementById('npo-id').value !== '' || document.getElementById('toast').className.includes('err')`);
 const poId=await run(`document.getElementById('npo-id').value`);assert.ok(poId,'PO not saved: '+await run(`document.getElementById('toast').textContent`));
 const po=await run(`fetch('/api/pos?search=RFQ-CHECK').then(r=>r.json()).then(l=>l.find(p=>p.po_id===${JSON.stringify(poId)}))`);
 assert.equal(po.linked_rfq,'RFQ-CHECK');
 const preview=await run(`fetch('/pos/'+encodeURIComponent(${JSON.stringify(poId)})+'/preview').then(r=>r.text())`);
 assert.ok(!preview.includes('RFQ-CHECK'),'RFQ reference shown on the PO preview');
 const rfq=await run(`fetch('/api/rfq').then(r=>r.json()).then(l=>l.find(r=>r.rfq_id==='RFQ-CHECK'))`);
 assert.equal(rfq.po_ids,poId);
 await run(`resetPoForm(false)`);
 assert.deepEqual(await run(`[document.getElementById('npo-rfq').value,document.getElementById('npo-rfq-lines').hidden]`),['',true]);
 const pickSupplier=name=>run(`(()=>{const s=document.getElementById('npo-supplier');s.value=${JSON.stringify(name)};s.dispatchEvent(new Event('change'));return [...document.querySelectorAll('#npo-rfq-lines:not([hidden]) button')].map(b=>b.dataset.rfq||'')})()`);
 assert.deepEqual(await pickSupplier('Other'),['RFQ-OPEN'],'only the recent, unclosed RFQ without a PO is suggested');
 await run(`document.querySelector('#npo-rfq-lines button').click()`);
 assert.equal(await run(`document.getElementById('npo-rfq').value`),'RFQ-OPEN');
 await wait(`document.querySelector('#npo-rfq-lines button')?.textContent.includes('Item 3')`);
 await run(`resetPoForm(false)`);
 assert.deepEqual(await pickSupplier('Target'),[],'an RFQ that already has a PO is not suggested');
 await run(`resetPoForm(false)`);
 await run(`(async()=>{poRfqs=poRfqs.filter(r=>r.rfq_id!=='RFQ-CHECK');document.getElementById('npo-rfq').value='RFQ-CHECK';await selectPoRfq()})()`);
 assert.equal(await run(`document.querySelectorAll('#npo-rfq-lines button').length`),2,'an RFQ outside the history list is fetched by id');
 await run(`resetPoForm(false)`);
 console.log('PASS: Make PO opens the form from an RFQ, fills the supplier, offers its lines to pick (qty, unit, ✓ when used), warns on a different supplier, saves linked_rfq internally (not on the preview), shows the PO on the RFQ list, a reset form has no RFQ, an RFQ older than the list is fetched by id, and picking a supplier suggests only its recent RFQs without a PO');
} finally {
 if(send&&ws?.readyState===WebSocket.OPEN){try{await send('Browser.close')}catch{}}
 ws?.close();
 if(chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve))}
 await delay(300);fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
