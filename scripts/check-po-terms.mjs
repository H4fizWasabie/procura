// Browser check for the terms-based default shipping status; run by check-ui-defects.py with CHECK_URL and an ADMIN CHECK_TOKEN.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'procura-po-terms-'));
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
 const shipFor=supplier=>run(`(()=>{const s=document.getElementById('npo-supplier');s.value=${JSON.stringify(supplier)};s.dispatchEvent(new Event('change'));return document.getElementById('npo-ship').value})()`);
 const openPos=async()=>{await send('Page.navigate',{url:base+'/pos'});await wait('location.pathname === "/pos" && document.readyState === "complete" && typeof resetPoForm === "function" && document.getElementById("po-sup-list").children.length > 0')};
 await openPos();
 assert.equal(await shipFor('Credit Co'),'Pending','setting off: day terms must not change shipping');
 await send('Page.navigate',{url:base+'/suppliers'});await wait('document.readyState === "complete" && !!document.getElementById("terms-auto")');
 assert.equal(await run(`document.getElementById('terms-auto').checked`),false);
 await run(`document.getElementById('terms-auto').click()`);
 await wait(`document.getElementById('toast').style.display === 'block'`);
 await openPos();
 assert.equal(await shipFor('Credit Co'),'Delivered');
 assert.equal(await shipFor('Cash Co'),'Pending');
 assert.equal(await shipFor('Target'),'Pending','blank terms start Pending');
 await shipFor('Credit Co');
 await run(`document.getElementById('npo-id').value='PO-EXISTING'`);
 assert.equal(await shipFor('Cash Co'),'Delivered','editing an existing PO must keep its shipping status');
 await send('Page.navigate',{url:base+'/suppliers'});await wait('document.readyState === "complete" && !!document.getElementById("terms-auto")');
 assert.equal(await run(`document.getElementById('terms-auto').checked`),true,'setting persists');
 await run(`document.getElementById('terms-auto').click()`);await wait(`document.getElementById('toast').style.display === 'block'`);
 console.log('PASS: admin toggle on the Suppliers page; with it on, a new PO starts Delivered for day terms and Pending for COD or blank terms; editing keeps the status; off leaves Pending');
} finally {
 if(send&&ws?.readyState===WebSocket.OPEN){try{await send('Browser.close')}catch{}}
 ws?.close();
 if(chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve))}
 await delay(300);fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
