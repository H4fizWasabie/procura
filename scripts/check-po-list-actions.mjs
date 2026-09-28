// Browser regression check against an isolated PROCURA_DEMO=1 workspace.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'procura-po-actions-'));
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
 await send('Runtime.enable');await send('Page.enable');
 const run=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
 const wait=async expression=>{for(let i=0;i<100;i++){if(await run(expression))return;await delay(100)}throw Error('Timed out: '+expression)};
 const base=process.env.CHECK_URL||'http://127.0.0.1:18766';
 await send('Page.navigate',{url:base+'/login'});await wait('location.pathname === "/login" && document.readyState === "complete"');
 const login=await run(`fetch('/api/login/demo',{method:'POST'}).then(r=>r.status)`);assert.equal(login,200);
 await send('Page.navigate',{url:base+'/pos'});await wait('location.pathname === "/pos" && document.readyState === "complete" && allPos.length >= 2');
 const ids=await run('allPos.slice(0,2).map(po=>po.po_id)');

 await run("document.querySelector('#po-body tr[data-open-po]').click()");await wait('selectedPo?.po_id === '+JSON.stringify(ids[0]));
 await run('closePoDetail()');
 await run("document.querySelectorAll('#po-body tr[data-open-po]')[1].click()");await wait('selectedPo?.po_id === '+JSON.stringify(ids[1]));
 await run('closePoDetail()');
 await run(`(()=>{const row=document.querySelectorAll('#po-body tr[data-open-po]')[1];row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);await wait('selectedPo?.po_id === '+JSON.stringify(ids[1]));
 assert.deepEqual(await run(`Array.from(document.querySelectorAll('#po-detail button')).map(button=>button.textContent.trim()).filter(text=>text==='Preview'||text==='Download PDF')`),['Preview','Download PDF']);
 await run('closePoDetail()');

 const actions=await run(`(()=>{const preview=[],pdf=[],oldPreview=previewPO,oldPDF=downloadPO;previewPO=id=>preview.push(id);downloadPO=id=>pdf.push(id);const rows=document.querySelectorAll('#po-body tr[data-open-po]');rows[0].querySelector('[data-po-preview]').click();rows[1].querySelector('[data-po-pdf]').click();previewPO=oldPreview;downloadPO=oldPDF;return {preview,pdf,view:poView}})()`);
 assert.deepEqual(actions,{preview:[ids[0]],pdf:[ids[1]],view:'history'});
 const endpoints=await run(`Promise.all(${JSON.stringify(ids)}.flatMap(id=>['preview','pdf'].map(async kind=>{const response=await fetch('/pos/'+encodeURIComponent(id)+'/'+kind);return [kind,response.status,response.headers.get('content-type'),(await response.arrayBuffer()).byteLength]})))`);
 for(const [kind,status,type,length] of endpoints){assert.equal(status,200,kind);assert.match(type,kind==='preview'?/html/:/pdf/);assert.ok(length>100,kind)}
 console.log('PASS: two different PO rows open by click, PO rows open by keyboard, row Preview and Print / PDF actions target their PO without opening the row, and both document routes return content');
} finally {
 if(send&&ws?.readyState===WebSocket.OPEN){try{await send('Browser.close')}catch{}}
 ws?.close();
 if(chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve))}
 await delay(300);fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
