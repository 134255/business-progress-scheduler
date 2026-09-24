const test=require('node:test'),assert=require('node:assert/strict')
const {analysisRecords,selection}=require('../../cloudfunctions/businessApi/test/helpers/field-analysis-fixtures')
const {buildFieldAnalysis}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis')
const rows=analysisRecords()
function response(query) {const {matchedNodeIds,...r}=buildFieldAnalysis(rows,query.analysis);return {...r,schemaVersion:1,scope:'authorized',incomplete:false,totalCount:r.items.length,hasMore:false,nextCursor:''}}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const tap=id=>({currentTarget:{dataset:{id}}})
function harness(handler=response,appOverride) {
  const app=appOverride||{globalData:{currentUser:{_id:'staff',role:'user',status:'active'}}},calls=[],events=[]
  global.getApp=()=>app;if(!appOverride)global.wx={}
  const cloud=require.resolve('../utils/cloud'),service=require.resolve('../services/business')
  const component=require('node:path').resolve(__dirname,'../components/operations-field-analysis/index.js')
  const saved=[cloud,service,component].map(p=>require.cache[p]);let definition
  require.cache[cloud]={id:cloud,filename:cloud,loaded:true,exports:{async callBusinessApi(action,payload){calls.push({action,payload});return handler(payload)}}}
  global.Component=d=>definition=d;delete require.cache[service];delete require.cache[component]
  try { require(component) } finally {delete global.Component;[cloud,service,component].forEach((p,i)=>{if(saved[i])require.cache[p]=saved[i];else delete require.cache[p]})}
  const c={...definition.methods,data:{...structuredClone(definition.data),enabled:true,query:{startDate:'2026-09-01'},sessionEpoch:1},
    setData(update){Object.assign(this.data,update)},triggerEvent(name,detail){events.push({name,detail})}}
  definition.lifetimes.attached.call(c)
  return {c,definition,app,calls,events}
}
const settle=()=>new Promise(r=>setImmediate(r))
test('component initially requests only catalog; expanding loads one node, show-all replaces preview',async()=>{
  const h=harness();await settle();assert.deepEqual(h.calls.map(c=>c.payload.analysis.view),['catalog'])
  assert.equal(h.c.data.panel,null);const id=h.c.data.nodes[0].id
  await h.c.toggleNode(tap(id));assert.equal(h.c.data.panel.view,'node')
  const field=h.c.data.panel.items[0]
  await h.c.showAllOptions(tap(field.id))
  assert.equal(h.c.data.panel.view,'field');assert.equal(h.c.data.panel.items.length,2)
  assert.deepEqual(h.events.at(-1).detail.selection.dimensionIds,[field.id])
})
test('late A response cannot replace B; hidden or detached work never restores private content',async()=>{
  for(const mode of ['new','hide','detach','account','role']) {
    const pending=deferred();let delayed=false
    const h=harness(query=>delayed?pending.promise:response(query));await settle();const id=h.c.data.nodes[0].id
    delayed=true;const old=h.c.toggleNode(tap(id))
    if(mode==='new') {delayed=false;await h.c.toggleNode(tap(id));await h.c.toggleNode(tap(id))}
    if(mode==='hide')h.definition.pageLifetimes.hide.call(h.c)
    if(mode==='detach')h.definition.lifetimes.detached.call(h.c)
    if(mode==='account')h.app.globalData.currentUser={...h.app.globalData.currentUser,_id:'other'}
    if(mode==='role')h.app.globalData.currentUser.role='super_admin'
    pending.resolve(response({analysis:selection(rows,'node')}));await old
    assert.equal(mode==='new'?h.c.data.panel.view:h.c.data.panel,mode==='new'?'node':null,mode)
  }
})
test('cancelled same-session permission denial clears results, old-account denial preserves new results',async()=>{
  for(const changeAccount of [false,true]) for(const code of ['FORBIDDEN','ACCOUNT_DISABLED']) {
    const pending=deferred();let delayed=false
    const h=harness(q=>delayed?pending.promise:response(q));await settle();const id=h.c.data.nodes[0].id
    delayed=true;const old=h.c.toggleNode(tap(id));delayed=false
    if(changeAccount) {h.app.globalData.currentUser={...h.app.globalData.currentUser,_id:'other'};h.c.data.sessionEpoch++;
      h.definition.observers['enabled, query, sessionEpoch'].call(h.c);await settle()}
    else await h.c.toggleNode(tap(id))
    await h.c.toggleNode(tap(id));assert.ok(h.c.data.panel)
    pending.reject(Object.assign(new Error('denied'),{code}));await old
    assert.equal(Boolean(h.c.data.panel),changeAccount)
    assert.equal(h.events.some(e=>e.name==='accessinvalid'),!changeAccount)
  }
})
test('pagination network failure retains prior page and cursor; retry appends once',async()=>{
  let pageCall=0
  const h=harness(query=>{
    const r=response(query)
    if(query.analysis.view==='field') {
      if(query.cursor && ++pageCall===1) throw new Error('offline')
      const offset=query.cursor?1:0;return {...r,items:r.items.slice(offset,offset+1),hasMore:!offset,nextCursor:offset?'':'page2'}
    }return r
  });await settle();await h.c.toggleNode(tap(h.c.data.nodes[0].id));await h.c.showAllOptions(tap(h.c.data.panel.items[0].id))
  await h.c.loadMoreAnalysis();assert.equal(h.c.data.panel.items.length,1);assert.equal(h.c.data.panel.nextCursor,'page2');assert.ok(h.c.data.panelError)
  await h.c.retryAnalysis();assert.equal(h.c.data.panel.items.length,2);assert.equal(h.c.data.panel.hasMore,false)
})
test('hide resets sensitive UI without emitting a new export selection',async()=>{
  const h=harness();await settle();await h.c.toggleNode(tap(h.c.data.nodes[0].id));const n=h.events.length
  h.definition.pageLifetimes.hide.call(h.c)
  assert.equal(h.c.data.panel,null);assert.deepEqual(h.c.data.nodes,[]);assert.equal(h.events.length,n)
})

test('incomplete or duplicate pair selection cannot leave stale pair results or export context',async()=>{
  const h=harness();await settle();await h.c.toggleNode(tap(h.c.data.nodes[0].id))
  const choose=(side,value)=>h.c.selectPairDimension({currentTarget:{dataset:{side}},detail:{value}})
  await choose('pairLeft',0);await choose('pairRight',1)
  assert.equal(h.c.data.panel.view,'pair')
  await choose('pairRight',0)
  assert.notEqual(h.c.data.panel?.view,'pair')
  assert.equal(h.events.at(-1).detail.selection.view,'node')
})
test('catalog paging cannot strand a node spinner and stale node controls clear on collapse',async()=>{
  const pending=deferred();let delayed=false
  const h=harness(q=>delayed?pending.promise:response(q));await settle();const id=h.c.data.nodes[0].id
  await h.c.toggleNode(tap(id));assert.ok(h.c.data.pairOptions.length)
  await h.c.toggleNode(tap(id));assert.deepEqual(h.c.data.pairOptions,[])
  delayed=true;const task=h.c.loadMoreNodes();delayed=false
  await h.c.toggleNode(tap(id))
  pending.resolve(response({analysis:selection(rows,'catalog')}));await task
  assert.equal(h.c.data.catalogLoading,false)
})

test('same-session denial survives display epoch refresh and native send hide, invalidating CSV',async()=>{
  for(const mode of ['refresh','native'])for(const code of ['FORBIDDEN','ACCOUNT_DISABLED']){
    const p=require('./helpers/operations-analysis-page-harness').harness();await p.page.onShow()
    const pending=deferred();let delayed=false
    const h=harness(q=>delayed?pending.promise:response(q),p.app);await settle()
    const original=h.c.triggerEvent
    h.c.triggerEvent=(name,detail)=>{original(name,detail);if(name==='accessinvalid')p.page.onFieldAnalysisAccessInvalid()}
    delayed=true;const task=h.c.toggleNode(tap(h.c.data.nodes[0].id));delayed=false
    await p.page.applyFilters();h.c.data.sessionEpoch=p.page.data.fieldAnalysisSessionEpoch
    h.definition.observers['enabled, query, sessionEpoch'].call(h.c);await settle()
    await h.c.toggleNode(tap(h.c.data.nodes[0].id));await p.page.exportCsv()
    assert.equal(p.page.data.exportReady,true)
    if(mode==='native'){
      p.page.exportCsv();p.page.onHide();h.definition.pageLifetimes.hide.call(h.c)
      h.c.data.sessionEpoch=p.page.data.fieldAnalysisSessionEpoch
    }
    pending.reject(Object.assign(new Error('denied'),{code}));await task
    assert.equal(h.c.data.panel,null);assert.equal(p.page.csvExport,null);assert.equal(p.page.data.exportReady,false)
    if(mode==='native'){p.shares[0].success({});assert.equal(p.page.data.exportReady,false)}
  }
})

test('confirmed source change invalidates the generated CSV before reloading analysis',async()=>{
  const p=require('./helpers/operations-analysis-page-harness').harness();await p.page.onShow()
  const h=harness(q=>{const r=response(q);if(q.analysis.view==='field'){
    if(q.cursor)throw Object.assign(new Error('changed'),{code:'REPORT_CHANGED'})
    return {...r,items:r.items.slice(0,1),hasMore:true,nextCursor:'next'}
  }return r},p.app);await settle()
  h.c.triggerEvent=(name,detail)=>{if(name==='analysischange')p.page.onFieldAnalysisChange({detail});if(name==='sourceinvalid')p.page.onFieldAnalysisSourceInvalid()}
  await h.c.toggleNode(tap(h.c.data.nodes[0].id));await h.c.showAllOptions(tap(h.c.data.panel.items[0].id))
  await p.page.exportCsv();assert.equal(p.page.data.exportReady,true)
  await h.c.loadMoreAnalysis();assert.equal(p.page.csvExport,null);assert.equal(p.page.data.exportReady,false)
})
