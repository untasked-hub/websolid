const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const status = require('./public/librarystatus.js');
const src = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
const section = src.slice(src.indexOf('  var partsLibraryAvailable = null;'), src.indexOf('  function savePart(forceNew)'));
const html = fs.readFileSync(__dirname + '/public/cad.html', 'utf8');
assert(html.includes('/librarystatus.js'));
assert.equal((html.match(/id="btn-parts-retry"/g) || []).length, 1);
assert.equal((html.match(/id="btn-parts-savefile"/g) || []).length, 1);
assert.equal((html.match(/id="btn-parts-openfile"/g) || []).length, 1);
assert(html.includes('Open portable .json file'));
assert(src.includes("var libraryOpenFile = document.getElementById('btn-parts-openfile')"));
assert(src.includes("libraryOpenFile.addEventListener('click', openPartFile)"));
assert(html.indexOf('/librarystatus.js') < html.indexOf('/cad.js'));
function setup() {
  const nodes = {};
  for (const id of ['parts-list','parts-library-hint','btn-parts-retry','btn-parts-savefile','btn-parts-openfile','btn-save','btn-save-as']) {
    nodes[id] = {innerHTML:'', textContent:'', hidden:false, classList:{toggle(){}},
      attrs:{}, setAttribute(k,v){this.attrs[k]=v;}};
  }
  let serial=0;
  const timers = new Map(), requests = [];
  const ctx = {window:{WebSolidLibraryStatus:status}, document:{getElementById:id=>nodes[id],querySelector:()=>null},
    updateSessionStatus(){}, clearTimeout:id=>timers.delete(id),
    setTimeout(fn,ms){ const id=++serial; timers.set(id,{fn,ms}); return id; },
    fetch(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));},
    AbortController:class {constructor(){this.signal={};} abort(){this.signal.aborted=true;}},
    partId:null};
  vm.createContext(ctx); vm.runInContext(section,ctx);
  return {ctx,nodes,requests,timers,fire(ms){const t=[...timers.entries()].find(([id,t])=>t.ms===ms);assert(t);timers.delete(t[0]);t[1].fn();}};
}
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
(async()=>{
  let h=setup(); h.ctx.refreshPartsList();
  assert.equal(h.nodes['parts-library-hint'].attrs['data-library-state'],'checking');
  assert(h.nodes['btn-save'].disabled);
  assert(h.nodes['btn-parts-savefile'].hidden);
  h.fire(4000); assert(!h.nodes['btn-parts-retry'].hidden);
  assert(!h.nodes['btn-parts-savefile'].hidden);
  assert(h.nodes['parts-library-hint'].textContent.includes('longer than usual'));
  h.fire(12000);
  assert.equal(h.nodes['parts-library-hint'].attrs['data-library-state'],'unavailable');
  assert(!h.nodes['btn-parts-savefile'].hidden);
  assert.equal(h.nodes['btn-parts-savefile'].textContent,'Save portable .json file instead');
  assert.equal(h.nodes['btn-parts-openfile'].hidden,false,'open action appears when library is unavailable');
  assert(h.nodes['btn-parts-openfile'].title.includes('from this device'));
  assert(h.nodes['parts-library-hint'].textContent.includes('timed out'));
  h.requests[0].resolve({ok:true,json:()=>Promise.resolve({parts:[]})}); await flush();
  assert.equal(h.ctx.partsLibraryAvailable,false,'late result must not override timeout');
  h.ctx.refreshPartsList();
  h.requests[1].resolve({ok:true,json:()=>Promise.resolve({parts:[]})}); await flush();
  assert.equal(h.ctx.partsLibraryAvailable,true);
  assert.equal(h.nodes['btn-save'].disabled,false);
  assert(h.nodes['btn-parts-retry'].hidden);
  assert(h.nodes['btn-parts-savefile'].hidden);
  assert(h.nodes['btn-parts-openfile'].hidden,'open action stays hidden when library is ready');
  assert(h.nodes['parts-library-hint'].textContent.includes('ready'));
  h=setup(); h.ctx.refreshPartsList(); h.ctx.refreshPartsList();
  h.requests[0].reject(new Error('old request')); await flush();
  h.fire(4000); // stale completion must not clear the newer slow timer
  assert.equal(h.ctx.partsLibraryAvailable,null);
  h.requests[1].resolve({ok:false}); await flush();
  assert.equal(h.ctx.partsLibraryAvailable,false);
  assert(!h.nodes['btn-parts-retry'].hidden);
  h=setup(); h.ctx.refreshPartsList();
  h.requests[0].resolve({ok:true,json:()=>Promise.resolve({wrong:[]})}); await flush();
  assert.equal(h.ctx.partsLibraryAvailable,false,'malformed response must not enable saves');
  h=setup(); h.ctx.refreshPartsList(); h.requests[0].reject(new Error('offline')); await flush();
  assert.equal(h.ctx.partsLibraryAvailable,false);
  assert(h.nodes['parts-library-hint'].textContent.includes('Save file'));
  for (const state of ['checking', 'unavailable']) {
    const description = status.statusFor(state, {slow:true}).hintText;
    assert(description.includes('to this device, not to the server'));
    assert(description.includes('Reopen it with Open file'));
    assert(description.includes('.websolid.json'));
  }
  console.log('PASS: checking, slow, timeout, late result, retry recovery, stale request, HTTP/malformed/network failure, portable-file persistence guidance');
})().catch(e=>{console.error(e);process.exitCode=1;});
