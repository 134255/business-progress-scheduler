'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {fixture}=require('./helpers/field-priority-fixture')
const {createFieldChangePriorityRecovery}=require('../lib/field-change-priority-recovery')
const {createFieldRecoveryBudget}=require('../lib/field-recovery-budget')
const CONTROL='operations-field-recovery-state-v1',CURSOR='operations-field-snapshot-cursor',Q='operations_field_refresh_queue'
const recovery=f=>createFieldChangePriorityRecovery({db:f.fake.db,...f})
test('a competing cursor move invalidates the old tail proof rather than closing repair',async()=>{
  const f=fixture(2),actual=f.sourceRecovery
  f.sourceRecovery={recoverCandidates:actual.recoverCandidates,async runRepairSlice(input){
    const r=await actual.runRepairSlice(input)
    if(r.cursorProof)f.fake.replace('system_settings',CURSOR,{_id:CURSOR,cursorId:'node-99999',version:r.cursorProof.version+1,updatedAt:f.clock()})
    return r
  }}
  await recovery(f).runCycle()
  assert.equal(f.fake.documents('system_settings').find(x=>x._id===CONTROL).repairActive,true)
  assert.equal(f.fake.documents('system_settings').find(x=>x._id===CURSOR).cursorId,'node-99999')
})
test('an older finisher cannot close a replacement repair generation',async()=>{
  const f=fixture(1),actual=f.sourceRecovery
  f.sourceRecovery={recoverCandidates:actual.recoverCandidates,async runRepairSlice(input){
    const r=await actual.runRepairSlice(input)
    if(r.cursorProof){const s=f.fake.documents('system_settings').find(x=>x._id===CONTROL);f.fake.replace('system_settings',CONTROL,{...s,revision:s.revision+1,repairEpoch:'e'.repeat(32)})}
    return r
  }}
  await recovery(f).runCycle();const s=f.fake.documents('system_settings').find(x=>x._id===CONTROL)
  assert.equal(s.repairEpoch,'e'.repeat(32));assert.equal(s.repairActive,true)
})
test('duplicate workers preserve original documents and cannot corrupt cursor progress',async()=>{
  const f=fixture(8),before=f.protectedState(),a=recovery(f),b=recovery(f)
  await Promise.all([a.runCycle(),b.runCycle()]);await a.runCycle()
  assert.equal(f.fake.documents('operations_field_snapshots').length,8)
  assert.deepEqual(f.protectedState(),before)
})
test('a slow source exhausts the one shared deadline and no later SDK call starts',async()=>{
  let f,armed=true
  f=fixture(3,{options:{transformRead({collection,data}){
    const last=f.fake.readCalls.at(-1)
    if(armed&&collection==='business_nodes'&&last&&last.collection===collection&&last.id===data._id){armed=false;f.advance(5000)}return data
  }}})
  const r=await recovery(f).runCycle()
  assert.equal(r.generated,0);assert.equal(r.failed,0)
  assert.equal(f.fake.readCalls.at(-1).collection,'business_nodes')
  assert.equal(f.fake.writeCalls.at(-1).id,CURSOR)
  const later=await recovery(f).runCycle();assert.equal(later.failed,0)
  assert.ok(f.fake.documents('operations_field_snapshots').some(x=>x.nodeId==='node-00003'))
})
test('claim-committed crash is recovered by a fresh worker without dropping its pending nodes',async()=>{
  const f=fixture(4),r=recovery(f);await r.runCycle();f.advance(60000)
  await f.queue.enqueue({businessLineId:'line-000'})
  await f.queue.claimVisit({observed:f.fake.documents(Q)[0],limit:2})
  assert.deepEqual(f.fake.documents(Q)[0].pendingNodeIds,['node-00001','node-00002'])
  for(let i=0;i<5&&f.fake.documents(Q).length;i++)await recovery(f).runCycle()
  assert.equal(f.fake.documents(Q).length,0)
})
test('an invalid queue item is rotated past so the next healthy line is processed',async()=>{
  const f=fixture(101),r=recovery(f)
  while((await r.runCycle()).hasMore){} // one initial full sweep
  await f.queue.enqueue({businessLineId:'line-000'});await f.queue.enqueue({businessLineId:'line-001'})
  const jobs=f.fake.documents(Q).sort((a,b)=>a._id.localeCompare(b._id)),bad=jobs[0]
  f.fake.replace(Q,bad._id,{...bad,revision:0})
  const healthy=jobs[1].businessLineId
  for(let i=0;i<20;i++)await r.runCycle()
  assert.equal(f.fake.documents(Q).some(x=>x.businessLineId===healthy),false)
  assert.equal(f.fake.documents(Q).some(x=>x._id===bad._id),true)
})
test('a failed queue write leaves its nodes discoverable and does not touch original notifications',async()=>{
  const f=fixture(3),r=recovery(f);await r.runCycle();await f.queue.enqueue({businessLineId:'line-000'})
  const before=f.protectedState()
  f.fake.failNextWrite({collection:Q,operation:'set',error:new Error('unknown storage failure')})
  assert.equal((await r.runCycle()).failed,1)
  assert.equal(f.fake.documents(Q).length,1)
  await r.runCycle();assert.equal(f.fake.documents(Q).length,0);assert.deepEqual(f.protectedState(),before)
})
test('direct queue recovery still refuses a foreign line hint and does not advance the global repair cursor',async()=>{
  const f=fixture(1),b=createFieldRecoveryBudget({clock:f.clock,timeBudgetMs:5000})
  const r=await f.sourceRecovery.recoverCandidates({candidates:[{_id:'node-00001',businessLineId:'foreign'}],budget:b})
  assert.equal(r.counts.failed,1);assert.equal(r.outcomes[0].status,'failed')
  assert.equal(f.fake.documents('operations_field_snapshots').length,0)
  assert.equal(f.fake.documents('system_settings').length,0)
})
test('changed source content during publication is not acknowledged as a successful old snapshot',async()=>{
  const f=fixture(1),original=f.fake.db.runTransaction
  let armed=true
  f.fake.db.runTransaction=async callback=>{
    if(armed){armed=false;const fb=f.fake.documents('node_feedback')[0];fb.fieldValues.find(v=>v.fieldKey==='choice').value='B';f.fake.replace('node_feedback',fb._id,fb)}
    return original.call(f.fake.db,callback)
  }
  const r=await f.sourceRecovery.recoverCandidates({candidates:[f.sources[0].node],budget:createFieldRecoveryBudget({clock:f.clock})})
  assert.equal(r.counts.failed,1);assert.equal(r.outcomes[0].status,'failed')
  assert.equal(f.fake.documents('operations_field_snapshots').length,0)
})

test('a millisecond-advancing clock completes repair with one exact completion-derived deadline',async()=>{
  const f=fixture(1)
  let stamp=f.clock().getTime()
  f.clock=()=>new Date(stamp++)
  const r=recovery(f)
  for(let i=0;i<3;i++)assert.equal((await r.runCycle()).failed,0)
  const state=f.fake.documents('system_settings').find(x=>x._id===CONTROL)
  assert.equal(state.repairActive,false)
  assert.equal(state.nextRepairAt.getTime()-state.repairCompletedAt.getTime(),3600000)
  assert.equal(f.fake.documents('operations_field_snapshots').length,1)
})

for(const failure of ['timeout','unknown'])test(`a recurring first-node ${failure} cannot starve healthy pending siblings`,async()=>{
  let f,armed=false
  const attempted=[]
  f=fixture(3,{options:{transformRead({collection,data}){
    const last=f.fake.readCalls.at(-1)
    if(armed&&collection==='business_nodes'&&last?.collection===collection&&last.id===data._id){
      attempted.push(data._id)
      if(data._id==='node-00001'){
        if(failure==='timeout')f.advance(5000)
        else throw Error('Persistent unknown source read failure')
      }
    }
    return data
  }}})
  const r=recovery(f);await r.runCycle()
  const feedback=f.fake.documents('node_feedback')[1]
  feedback.fieldValues.find(x=>x.fieldKey==='choice').value='B'
  f.fake.replace('node_feedback',feedback._id,feedback)
  await f.queue.enqueue({businessLineId:'line-000'});armed=true
  for(let i=0;i<6;i++)await r.runCycle()
  assert.ok(attempted.includes('node-00002'),'healthy sibling must be attempted without waiting for the hourly sweep')
  assert.ok(f.fake.documents('operations_field_snapshots').find(x=>x.nodeId==='node-00002').fields.some(x=>x.fieldKey==='choice'&&x.value==='B'))
  assert.ok(f.fake.documents(Q)[0].pendingNodeIds.includes('node-00001'),'failed work must remain pending')
  assert.equal(f.fake.documents('system_settings').find(x=>x._id===CONTROL).repairActive,false)
})
