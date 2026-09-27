import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const failures=[];
async function check(name, fn){try{await fn(); console.log('PASS:',name)}catch(e){failures.push(name);console.log('FAIL:',name,e.message)}}
function context(file){
 const elements=new Map();
 const document={getElementById(id){if(!elements.has(id))elements.set(id,{value:'',checked:false,textContent:'',innerHTML:'',disabled:false,style:{},scrollIntoView(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)},querySelectorAll(){return []},createElement(){return {set textContent(v){this.innerHTML=v},innerHTML:''}},addEventListener(){}};
 const c=vm.createContext({document,URLSearchParams,AbortController,console,setTimeout(){},fetch(){throw Error('unexpected request')}});
 let source=fs.readFileSync('templates/'+file+'.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 source=source.replace(/(?:initPo|loadWf|initReports|init|loadSummary)\(\);\s*$/,'');vm.runInContext(source,c);
 c.messages=[];c.toast=(message,ok)=>c.messages.push({message,ok});return c;
}
await check('PO status makes one request and reports a rejected save',async()=>{
 const c=context('pos');vm.runInContext("selectedPoId='PO-CHECK'",c);c.document.getElementById('po-edit-status').value='Paid';const calls=[];c.loadPos=()=>{};
 c.fetch=async(url)=>{calls.push(url);return {ok:false,json:async()=>({success:false,error:'Rejected'})}};
 await c.updatePoField('status');assert.deepEqual(calls,['/api/pos/PO-CHECK/status']);assert.equal(c.messages.at(-1).ok,false);
});
await check('PO network failure does not report success',async()=>{const c=context('pos');vm.runInContext("selectedPoId='PO-CHECK'",c);c.fetch=async()=>{throw Error('offline')};await c.updatePoField('ship');assert.equal(c.messages.at(-1).ok,false)});
await check('batch continues after failures and retains failed selections',async()=>{
 const c=context('workflow');vm.runInContext("selected=new Set(['GOOD','BAD','OFFLINE'])",c);
 c.fetch=async(url,opts)=>{if(!opts)return {ok:true,json:async()=>[{po_id:'BAD',status:'Pending Approval'},{po_id:'OFFLINE',status:'Pending Approval'}]};let id=JSON.parse(opts.body).po_id;if(id==='OFFLINE')throw Error('offline');return {ok:id==='GOOD',json:async()=>({success:id==='GOOD',error:'Rejected'})}};
 await c.batchAction();assert.deepEqual([...vm.runInContext('selected',c)],['BAD','OFFLINE']);assert.equal(c.messages.at(-1).ok,false);assert.match(c.document.getElementById('wf-results').textContent,/Succeeded: GOOD/);assert.match(c.document.getElementById('wf-results').textContent,/BAD/);assert.match(c.document.getElementById('wf-results').textContent,/OFFLINE/);assert.equal(c.document.getElementById('wf-action-btn').disabled,false);
});
await check('history selection has no undefined onchange and only checked items are submitted',async()=>{
 const c=context('reports');const responses=[{stock_id:'A',item_name:'A'},{stock_id:'B',item_name:'B'}];let body;c.document.getElementById('ih-search').value='Item';c.fetch=async(url,opts)=>{if(opts){body=JSON.parse(opts.body);return {json:async()=>[]}}return {json:async()=>responses}};
 await c.searchPoItems();assert.ok(!c.document.getElementById('ih-results').innerHTML.includes('updateSelectedItems()'));c.document.querySelectorAll=()=>[{dataset:{idx:'1'}}];await c.runItemHistory();assert.deepEqual(body,[{id:'B',name:'B'}]);
});
await check('inventory requests filters and honours server next-page state',async()=>{
 const c=context('inventory');c.document.getElementById('f-supplier').value='Target';c.document.getElementById('f-active').checked=true;c.document.getElementById('f-low-stock').checked=true;let url;c.fetch=async u=>{url=u;return {ok:true,headers:{get:()=> 'true'},json:async()=>[]}};await c.loadPage(1);const q=new URL(url,'http://local').searchParams;assert.equal(q.get('supplier'),'Target');assert.equal(q.get('active'),'1');assert.equal(q.get('low_stock'),'1');assert.equal(c.document.getElementById('next-btn').disabled,false);
});
await check('scorecard sends supplier/comments with server field names',async()=>{
 const c=context('scorecard');c.document.getElementById('rm-supplier').textContent='Supplier';c.document.getElementById('rm-comment').value='Note';let body;c.fetch=async(url,opts)=>{body=JSON.parse(opts.body);return {ok:false,json:async()=>({success:false,error:'Rejected'})}};await c.submitScore();assert.equal(body.supplier_name,'Supplier');assert.equal(body.comments,'Note');assert.equal(c.messages.at(-1).ok,false);
});
assert.equal(failures.length,0,failures.join('; '));
