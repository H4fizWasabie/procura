// Browser check for pending tasks on the overview; run by check-ui-defects.py with CHECK_URL and an ADMIN CHECK_TOKEN.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'procura-overview-tasks-'));
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
 const home=async()=>{await send('Page.navigate',{url:base+'/'});await wait('location.pathname === "/" && document.readyState === "complete" && document.getElementById("ot-list").innerHTML !== ""')};
 await home();
 await run(`fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'For editor',assigned_to:'EDITOR@test.local'})})`);
 await home();
 const titles=()=>run(`[...document.querySelectorAll('#ot-list .ot-row strong')].map(e=>e.textContent)`);
 assert.deepEqual(await titles(),['For editor']);
 assert.match(await run(`document.querySelector('#ot-list .ot-meta:last-child').textContent`),/From ADMIN · For EDITOR · today/);
 await run(`(()=>{document.getElementById('ot-title').value='Check stock';document.getElementById('ot-notes').value='Before Friday';document.getElementById('ot-assign').value='ADMIN@test.local';document.querySelector('#overview-tasks form button').click()})()`);
 await wait(`document.querySelectorAll('#ot-list .ot-row').length === 2`);
 assert.deepEqual(await titles(),['Check stock','For editor'],'tasks for me come first');
 assert.equal(await run(`document.querySelector('#ot-list .badge')?.textContent`),'For you');
 await wait(`document.getElementById('task-count').textContent === '1'`);
 assert.equal(await run(`document.getElementById('ot-title').value`),'','form resets after adding');
 await run(`doneOverviewTask(0)`);
 await wait(`document.querySelectorAll('#ot-list .ot-row').length === 1 && document.getElementById('task-count').hidden`);
 const done=await run(`fetch('/api/tasks').then(r=>r.json()).then(l=>l.find(t=>t.title==='Check stock'))`);
 assert.equal(done.status,'Done');assert.equal(done.created_by,'ADMIN@test.local');assert.equal(done.notes,'Before Friday');
 await send('Page.navigate',{url:base+'/tasks'});await wait('location.pathname === "/tasks" && document.readyState === "complete" && tasks.length >= 2');
 assert.equal(await run(`document.querySelector('.primary-nav a[href="/tasks"]') !== null`),true,'Tasks is in the main nav');
 await run(`editTask(tasks.find(t=>t.title==='Check stock').id)`);
 assert.equal(await run(`document.getElementById('tm-assign').value`),'ADMIN@test.local');
 await run(`saveTask()`);await wait(`document.getElementById('task-modal').classList.contains('open') === false`);
 const edited=await run(`fetch('/api/tasks').then(r=>r.json()).then(l=>l.find(t=>t.title==='Check stock'))`);
 assert.equal(edited.status,'Done','editing keeps a done task done');
 console.log('PASS: overview lists pending tasks (for you first, from/for/age), adds a task with an assignee, marks it done in place, updates the sidebar count; Tasks is in the main nav and editing keeps creator, assignee and status');
} finally {
 if(send&&ws?.readyState===WebSocket.OPEN){try{await send('Browser.close')}catch{}}
 ws?.close();
 if(chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve))}
 await delay(300);fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
