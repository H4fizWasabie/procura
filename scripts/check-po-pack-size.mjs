// Browser check for PO pack size entry; run by check-ui-defects.py with CHECK_URL and an ADMIN CHECK_TOKEN.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'procura-po-pack-'));
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
 await send('Page.navigate',{url:base+'/pos'});await wait('location.pathname === "/pos" && document.readyState === "complete" && poItemMaster.length > 0');
 await run(`(()=>{showPoView('new');const v=(id,x)=>document.getElementById(id).value=x;
  v('npo-supplier',document.querySelector('#po-sup-list option').value);const dept=document.getElementById('npo-dept');dept.value=[...dept.options].find(o=>o.value).value;
  const item=poItemMaster.find(i=>i.pack_qty==null&&String(i.exclude)!=='1');window.checkStock=item.stock_id;
  v('npo-item-search','['+item.stock_id+'] '+item.item_name);fillSupplierUOM();
  v('npo-sup-uom','box');v('npo-qty','2');v('npo-line-total','40');v('npo-pack-qty','100');v('npo-pack-uom','box');addPoItem()})()`);
 assert.deepEqual(await run('[poItems[0].pack_qty,poItems[0].pack_uom,poItems[0].supplier_uom]'),['100','box','box']);
 await run('savePo()');await wait(`document.getElementById('npo-id').value !== '' || document.getElementById('toast').className.includes('err')`);assert.equal(await run(`document.getElementById('toast').className.includes('err') ? document.getElementById('toast').textContent : ''`),'');
 const poId=await run(`document.getElementById('npo-id').value`);
 const item=await run(`fetch('/api/inventory/detail?stock_id='+encodeURIComponent(checkStock)).then(r=>r.json())`);
 assert.deepEqual([item.pack_qty,item.pack_uom,item.pack_size],[100,'box','100/box']);
 const po=await run(`fetch('/api/pos?search='+encodeURIComponent(${JSON.stringify(poId)})).then(r=>r.json()).then(list=>list[0])`);
 assert.equal(po.items[0].supplier_uom,'box');
 assert.ok(!JSON.stringify(po).includes('100/box')&&!('pack_qty' in po.items[0]),'pack size leaked into the PO record');
 const preview=await run(`fetch('/pos/'+encodeURIComponent(${JSON.stringify(poId)})+'/preview').then(r=>r.text())`);
 assert.ok(!preview.includes('100/box'),'pack size shown on the PO preview');
 await run(`selectedPoId=${JSON.stringify(poId)};selectedPo=allPos.find(p=>p.po_id===selectedPoId);poFormBaseline=poFormSnapshot();editSelectedPo()`);
 assert.deepEqual(await run('[poItems[0].pack_qty,poItems[0].pack_uom]'),['100','box']);
 console.log('PASS: pack size entered on a PO line updates the item (100/box), Sup.UOM saves as a listed unit, the PO record and preview carry no pack size, and editing the PO prefills pack from the item');
} finally {
 if(send&&ws?.readyState===WebSocket.OPEN){try{await send('Browser.close')}catch{}}
 ws?.close();
 if(chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve))}
 await delay(300);fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
