'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {fixture}=require('./helpers/field-priority-fixture')
const file=path.join(__dirname,'../lib/field-change-priority-recovery.js')
const create=fs.existsSync(file)?require(file).createFieldChangePriorityRecovery:undefined
const state=f=>f.fake.documents('system_settings').find(x=>x._id==='operations-field-recovery-state-v1')
function harness(count,options){assert.equal(typeof create,'function','change-priority recovery capability missing');const f=fixture(count,options);return {...f,recovery:create({db:f.fake.db,...f})}}
test('cold activation completes real repair and schedules the next repair after completion',async()=>{
  const f=harness(30),before=f.protectedState(),result=await f.recovery.runCycle()
  assert.equal(result.examined,30);assert.equal(result.generated,30);assert.equal(result.failed,0)
  assert.equal(state(f).repairActive,false)
  assert.equal(state(f).nextRepairAt.getTime(),f.clock().getTime()+3600000)
  assert.deepEqual(f.protectedState(),before)
})
test('idle calls before one full hour fresh-check the queue but do not reread history or write timestamps',async()=>{
  const f=harness(3);await f.recovery.runCycle();const reads=f.fake.readCalls.length,writes=f.fake.writeCalls.length,queries=f.fake.queryCalls.length
  f.advance(3599999);const r=await f.recovery.runCycle()
  assert.equal(r.examined,0);assert.equal(f.fake.writeCalls.length,writes)
  assert.ok(f.fake.readCalls.slice(reads).every(x=>x.collection==='system_settings'))
  assert.ok(f.fake.queryCalls.slice(queries).every(x=>x.collection==='operations_field_refresh_queue'))
  f.advance(1);assert.equal((await f.recovery.runCycle()).examined,3)
})
test('a new queue generation is processed before the next full repair is due',async()=>{
  const f=harness(3);await f.recovery.runCycle();f.advance(60000)
  const feedback=f.fake.documents('node_feedback')[0]
  feedback.fieldValues.find(x=>x.fieldKey==='choice').value='B';f.fake.replace('node_feedback',feedback._id,feedback)
  await f.queue.enqueue({businessLineId:feedback.businessLineId})
  const r=await f.recovery.runCycle()
  assert.equal(r.generated,1);assert.equal(f.fake.documents('operations_field_refresh_queue').length,0)
  assert.equal(f.fake.documents('operations_field_snapshots')[0].fields.find(x=>x.fieldKey==='choice').value,'B')
})
test('unfinished repairs continue on the next invocation instead of waiting another hour',async()=>{
  const f=harness(41);const a=await f.recovery.runCycle();assert.equal(a.examined,40);assert.equal(state(f).repairActive,true)
  f.advance(60000);const b=await f.recovery.runCycle();assert.equal(b.examined,1);assert.equal(state(f).repairActive,false)
  assert.equal(f.fake.documents('operations_field_snapshots').length,41)
})
test('busy queue and full repair share forty candidates and retain repair-first fairness',async()=>{
  const f=harness(150);await f.queue.enqueue({businessLineId:'line-000'});await f.queue.enqueue({businessLineId:'line-001'})
  const r=await f.recovery.runCycle();assert.ok(r.examined<=40);assert.ok(r.examined>=8)
  const cursor=f.fake.documents('system_settings').find(x=>x._id==='operations-field-snapshot-cursor')
  assert.equal(cursor.cursorId,'node-00008');assert.equal(state(f).repairActive,true)
  assert.ok(f.fake.transactionRuns.every(x=>x.operations<=100))
})
test('zero stage budget performs no database operation',async()=>{
  const f=harness(2);assert.deepEqual(await f.recovery.runCycle({timeBudgetMs:0}),{examined:0,generated:0,failed:0,hasMore:true})
  assert.equal(f.fake.readCalls.length,0);assert.equal(f.fake.queryCalls.length,0);assert.equal(f.fake.writeCalls.length,0)
})
test('a malformed future repair timestamp cannot silently disable repair forever',async()=>{
  const f=harness(1);await f.recovery.runCycle();const old=state(f)
  f.fake.replace('system_settings',old._id,{...old,nextRepairAt:new Date('2099-01-01T00:00:00Z')})
  const writes=f.fake.writeCalls.length,r=await f.recovery.runCycle()
  assert.equal(r.failed,1);assert.equal(f.fake.writeCalls.length,writes)
})
test('clock reversal cannot overwrite newer persisted scheduler state',async()=>{
  const f=harness(1);await f.recovery.runCycle();f.advance(-1)
  const writes=f.fake.writeCalls.length;assert.equal((await f.recovery.runCycle()).failed,1)
  assert.equal(f.fake.writeCalls.length,writes)
})
