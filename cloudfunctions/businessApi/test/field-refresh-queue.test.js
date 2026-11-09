'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const file = path.join(__dirname, '../lib/cloud-field-refresh-queue.js')
const factory = fs.existsSync(file) ? require(file).createCloudFieldRefreshQueue : undefined
const NOW = new Date('2026-11-09T03:00:00Z')
const Q = 'operations_field_refresh_queue'
function harness(count = 3, options = {}) {
  assert.equal(typeof factory, 'function', 'private field refresh queue capability is missing')
  const nodes = Array.from({length:count}, (_,i)=>({_id:`node-${String(i+1).padStart(3,'0')}`,businessLineId:'line-1'}))
  const fake = createFakeCloudDatabase({business_nodes:nodes}, {rejectExplicitIdOnSet:true,...options})
  let n = 0
  const queue = factory({db:fake.db,clock:()=>NOW,tokenFactory:()=> (++n).toString(16).padStart(32,'0')})
  return {fake,queue,job:()=>fake.documents(Q)[0]}
}
test('a second enqueue coalesces the line and invalidates the previous generation', async()=>{
  const h=harness(); const a=await h.queue.enqueue({businessLineId:'line-1'})
  const b=await h.queue.enqueue({businessLineId:'line-1'})
  assert.equal(a.id,b.id); assert.notEqual(a.enqueueToken,b.enqueueToken)
  assert.equal(h.fake.documents(Q).length,1); assert.equal(b.revision,2)
  assert.deepEqual(h.job().pendingNodeIds,[])
  assert.equal(h.fake.writeCalls.every(x=>x.collection===Q),true)
})
test('claimed nodes are durable before work starts and only successful nodes are acknowledged',async()=>{
  const h=harness(); await h.queue.enqueue({businessLineId:'line-1'})
  const visit=await h.queue.claimVisit({observed:h.job(),limit:8})
  assert.deepEqual(visit.claim.nodeIds,['node-001','node-002','node-003'])
  assert.deepEqual(h.job().pendingNodeIds,visit.claim.nodeIds)
  await h.queue.ackVisit({claim:visit.claim,completedIds:['node-001','node-003']})
  assert.deepEqual(h.job().pendingNodeIds,['node-002'])
  const retry=await h.queue.claimVisit({observed:h.job(),limit:8})
  assert.deepEqual(retry.claim.nodeIds,['node-002'])
  await h.queue.ackVisit({claim:retry.claim,completedIds:['node-002']})
  assert.equal(h.fake.documents(Q).length,0)
})
test('an old acknowledgement cannot delete a newly enqueued generation',async()=>{
  const h=harness(1); await h.queue.enqueue({businessLineId:'line-1'})
  const a=await h.queue.claimVisit({observed:h.job(),limit:8})
  await h.queue.enqueue({businessLineId:'line-1'})
  assert.equal(await h.queue.ackVisit({claim:a.claim,completedIds:['node-001']}),null)
  assert.equal(h.fake.documents(Q).length,1)
})
test('delete and recreate at the same revision is not an ABA match',async()=>{
  const h=harness(1); await h.queue.enqueue({businessLineId:'line-1'})
  const a=await h.queue.claimVisit({observed:h.job(),limit:8})
  await h.queue.ackVisit({claim:a.claim,completedIds:['node-001']})
  await h.queue.enqueue({businessLineId:'line-1'})
  const b=await h.queue.claimVisit({observed:h.job(),limit:8})
  assert.equal(a.claim.revision,b.claim.revision)
  assert.notEqual(a.claim.enqueueToken,b.claim.enqueueToken)
  assert.equal(await h.queue.ackVisit({claim:a.claim,completedIds:['node-001']}),null)
  assert.equal(h.fake.documents(Q).length,1)
})
test('a page discovered before a concurrent enqueue cannot move the new cursor',async()=>{
  const h=harness(); await h.queue.enqueue({businessLineId:'line-1'}); const old=h.job()
  h.fake.beforeNextTransaction(()=>h.queue.enqueue({businessLineId:'line-1'}))
  assert.equal(await h.queue.claimVisit({observed:old,limit:8}),null)
  assert.equal(h.job().afterNodeId,null)
})
test('a failing pending node does not prevent discovering its healthy successors',async()=>{
  const h=harness(12); await h.queue.enqueue({businessLineId:'line-1'})
  let visit=await h.queue.claimVisit({observed:h.job(),limit:2})
  await h.queue.ackVisit({claim:visit.claim,completedIds:['node-002']})
  const seen=[]
  for(let i=0;i<20 && h.job();i++) {
    visit=await h.queue.claimVisit({observed:h.job(),limit:2}); if(!visit) break
    seen.push(...visit.claim.nodeIds)
    await h.queue.ackVisit({claim:visit.claim,completedIds:visit.claim.nodeIds.filter(id=>id!=='node-001')})
  }
  assert.ok(seen.includes('node-012')); assert.deepEqual(h.job().pendingNodeIds,['node-001'])
})
test('a one-candidate budget alternates retry and new discovery without starving either',async()=>{
  const h=harness(4); await h.queue.enqueue({businessLineId:'line-1'})
  const seen=[]
  for(let i=0;i<10;i++) {
    const v=await h.queue.claimVisit({observed:h.job(),limit:1}); seen.push(...v.claim.nodeIds)
    await h.queue.ackVisit({claim:v.claim,completedIds:v.claim.nodeIds.filter(id=>id!=='node-001')})
  }
  assert.ok(seen.includes('node-004')); assert.ok(seen.filter(id=>id==='node-001').length>=2)
})
test('exact full pages require a later empty page before queue completion',async()=>{
  const h=harness(8); await h.queue.enqueue({businessLineId:'line-1'})
  const a=await h.queue.claimVisit({observed:h.job(),limit:8})
  await h.queue.ackVisit({claim:a.claim,completedIds:a.claim.nodeIds})
  assert.equal(h.job().discoveryDone,false)
  const b=await h.queue.claimVisit({observed:h.job(),limit:8})
  assert.equal(b.jobFinished,true); assert.equal(h.job(),undefined)
})
test('a hundred-node line finishes but the 101st node is never silently truncated',async()=>{
  for(const count of [100,101]) {
    const h=harness(count); await h.queue.enqueue({businessLineId:'line-1'})
    let error
    for(let i=0;i<30 && h.job();i++) {
      try {
        const v=await h.queue.claimVisit({observed:h.job(),limit:8})
        if(!v.jobFinished) await h.queue.ackVisit({claim:v.claim,completedIds:v.claim.nodeIds})
      } catch(e) {error=e;break}
    }
    if(count===100) assert.equal(h.job(),undefined)
    else {assert.equal(error.code,'FIELD_REFRESH_QUEUE_INVALID'); assert.ok(h.job())}
    assert.ok(h.fake.transactionRuns.every(x=>x.operations<=100))
  }
})
for(const kind of ['version','extra','getter','prototype','duplicate']) test(`corrupt ${kind} queue is not overwritten`,async()=>{
  let armed=false
  const h=harness(2,{transformRead:({collection,data})=>{
    if(!armed || collection!==Q) return data
    if(kind==='getter') Object.defineProperty(data,'revision',{get(){throw Error('getter executed')}})
    if(kind==='prototype') Object.setPrototypeOf(data,{other:true})
    return data
  }})
  await h.queue.enqueue({businessLineId:'line-1'}); let job=h.job()
  if(kind==='version') job.revision=Number.MAX_SAFE_INTEGER
  if(kind==='extra') job.privateContent='forbidden'
  if(kind==='duplicate') job.pendingNodeIds=['node-001','node-001']
  h.fake.replace(Q,job._id,job); armed=true
  const writes=h.fake.writeCalls.length
  await assert.rejects(h.queue.enqueue({businessLineId:'line-1'}),{code:'FIELD_REFRESH_QUEUE_INVALID'})
  assert.equal(h.fake.writeCalls.length,writes)
})
test('unknown commit after claim preserves pending nodes and does not replay the claim',async()=>{
  let armed=false
  const h=harness(2,{afterTransaction(){if(armed) throw Error('unknown commit')}})
  await h.queue.enqueue({businessLineId:'line-1'}); armed=true
  const start=h.fake.transactionRuns.length
  await assert.rejects(h.queue.claimVisit({observed:h.job(),limit:8}),/unknown commit/)
  assert.equal(h.fake.transactionRuns.length-start,1)
  assert.deepEqual(h.job().pendingNodeIds,['node-001','node-002'])
})
test('expired shared budget cannot start a queue database request',async()=>{
  const h=harness(); await h.queue.enqueue({businessLineId:'line-1'})
  const before=h.fake.queryCalls.length
  await assert.rejects(h.queue.listJobs({afterId:null,limit:8,check(){throw Error('expired')}}),/expired/)
  assert.equal(h.fake.queryCalls.length,before)
})

for(const committed of [false,true])test(`unknown acknowledgement ${committed?'after':'before'} commit is not replayed and never consumes a later generation`,async()=>{
  let armed=false
  const h=harness(1,{afterTransaction(){if(armed&&committed)throw Error('unknown acknowledgement')}})
  await h.queue.enqueue({businessLineId:'line-1'})
  const visit=await h.queue.claimVisit({observed:h.job(),limit:8})
  if(!committed)h.fake.failNextWrite({collection:Q,operation:'remove',error:new Error('unknown acknowledgement')})
  const before=h.fake.transactionRuns.length;armed=true
  await assert.rejects(h.queue.ackVisit({claim:visit.claim,completedIds:['node-001']}),/unknown acknowledgement/)
  assert.equal(h.fake.transactionRuns.length-before,1)
  assert.equal(h.fake.documents(Q).length,committed?0:1)
  armed=false;await h.queue.enqueue({businessLineId:'line-1'})
  assert.equal(await h.queue.ackVisit({claim:visit.claim,completedIds:['node-001']}),null)
  assert.equal(h.fake.documents(Q).length,1)
})
test('job listing follows bounded keyset ordering and does not read business contents',async()=>{
  const h=harness(); for(let i=1;i<=10;i++) await h.queue.enqueue({businessLineId:`line-${i}`})
  const first=await h.queue.listJobs({afterId:null,limit:8})
  const last=await h.queue.listJobs({afterId:first.jobs.at(-1)._id,limit:8})
  assert.equal(first.jobs.length,8); assert.equal(last.jobs.length,2); assert.equal(last.tail,true)
  assert.equal(h.fake.readCalls.some(x=>x.collection==='business_nodes'),false)
})
