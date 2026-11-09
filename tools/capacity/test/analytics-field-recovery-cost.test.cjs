'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs')
const root=path.resolve(__dirname,'../../..')
const original=require('../../../cloudfunctions/businessApi/test/helpers/fake-cloud-database').createFakeCloudDatabase
const meterFile=path.join(__dirname,'../lib/analytics-field-recovery-meter.cjs')
const meterModule=fs.existsSync(meterFile)?require(meterFile):{}
test('missing get attempts and rolled-back writes are counted, never described as committed',async()=>{
  assert.equal(typeof meterModule.createOperationMeter,'function','SDK boundary meter missing')
  const f=original(),m=meterModule.createOperationMeter(f.db)
  await assert.rejects(m.db.collection('x').doc('missing').get())
  await assert.rejects(m.db.runTransaction(async tx=>{await tx.collection('x').doc('new').set({data:{value:1}});throw Error('rollback')}))
  const t=m.report().totals
  assert.equal(t.get,1);assert.equal(t.set,1);assert.equal(t.acknowledgedWrites,0)
  assert.equal(t.transactionFailures,1);assert.equal(f.documents('x').length,0)
})
test('read responses and writes are attributed by actual phase, collection and bytes',async()=>{
  assert.equal(typeof meterModule.createOperationMeter,'function')
  const f=original({x:[{_id:'a',value:'abc'}]}),m=meterModule.createOperationMeter(f.db)
  await m.inPhase('field',async()=>{await m.db.collection('x').doc('a').get();await m.db.collection('x').where({}).limit(1).get()})
  await m.inPhase('mutation',()=>m.db.collection('x').doc('a').update({data:{value:'def'}}))
  const r=m.report();assert.equal(r.byPhase.field.get,1);assert.equal(r.byPhase.field.query,1)
  assert.equal(r.byPhase.field.returnedDocuments,2);assert.ok(r.totals.responseBytes>0);assert.ok(r.totals.writeBytes>0)
  assert.equal(r.byPhase.mutation.update,1);assert.equal(r.totals.acknowledgedWrites,1)
})
test('shallow transaction-map capacity adapter matches the original rollback, conflict and nested-copy semantics',async()=>{
  assert.equal(typeof meterModule.createCapacityDatabase,'function')
  const run=async factory=>{
    const f=factory({x:[{_id:'a',nested:{v:1}}]})
    const read=await f.db.collection('x').doc('a').get();read.data.nested.v=999
    await assert.rejects(f.db.runTransaction(async tx=>{await tx.collection('x').doc('a').update({data:{nested:{v:3}}});throw Error('rollback')}))
    let once=true
    await f.db.runTransaction(async tx=>{const v=await tx.collection('x').doc('a').get();if(once){once=false;f.replace('x','a',{nested:{v:4}})}await tx.collection('x').doc('a').update({data:{nested:{v:v.data.nested.v+1}}})})
    return {docs:f.documents('x'),queries:f.queryCalls,reads:f.readCalls.map(x=>({collection:x.collection,id:x.id,transaction:x.transaction})),runs:f.transactionRuns}
  }
  assert.deepEqual(await run(meterModule.createCapacityDatabase),await run(original))
})
test('full handler comparison retains original data and includes scheduler overhead on the first cycle',async()=>{
  const file=path.join(__dirname,'../analytics-field-recovery-cost.cjs')
  const run=fs.existsSync(file)?require(file).runComparison:undefined
  assert.equal(typeof run,'function','matched real handler comparison missing')
  const r=await run({baselineRoot:root,candidateRoot:root,scenario:{count:3,reviewed:true},intervalMinutes:1,cycles:10})
  assert.equal(r.protectedStateEqual,true);assert.equal(r.snapshotsEqual,true)
  assert.ok(r.candidate.firstCycle.totals.set>r.baseline.firstCycle.totals.set)
  assert.ok(r.candidate.totals.get<r.baseline.totals.get)
  assert.equal(r.cloudRequests,0);assert.equal(r.cashSavingsVerified,false)
})
test('the complete handler produces matching results and every SDK count with the original and capacity adapters',async()=>{
  const run=require('../analytics-field-recovery-cost.cjs').runComparison
  let originalCalls=0
  const options={baselineRoot:root,candidateRoot:root,scenario:{count:3,reviewed:true,pattern:'single'},intervalMinutes:5,cycles:3}
  const real=await run({...options,databaseFactory:(seed,opts)=>{originalCalls++;return original(seed,opts)}})
  assert.equal(originalCalls,2,'both compared sides must really construct the original SDK test adapter')
  const fast=await run(options)
  for(const side of ['baseline','candidate']) {
    assert.deepEqual(fast[side].totals,real[side].totals)
    assert.equal(fast[side].snapshotsHash,real[side].snapshotsHash)
    assert.equal(fast[side].protectedHash,real[side].protectedHash)
  }
})

test('an actual enqueue SDK write failure is measured without changing the successful API result',async()=>{
  const r=await require('../analytics-field-recovery-cost.cjs').runComparison({baselineRoot:root,scenario:{count:3,reviewed:true,pattern:'enqueue-failed'},intervalMinutes:5,cycles:15})
  assert.equal(r.candidate.mutationCount,1)
  assert.equal(r.candidate.totals.transactionFailures,1)
  assert.ok(r.candidate.byPhase.apiPostSuccess.set>r.baseline.byPhase.apiPostSuccess.set)
  assert.equal(r.snapshotsEqual,true)
  assert.equal(r.candidate.unresolvedTargets,0)
})

test('a rejected SDK write caught within a successful transaction is attempted but never acknowledged',async()=>{
  const f=original(),m=meterModule.createOperationMeter(f.db)
  f.failNextWrite({collection:'x',operation:'set',error:new Error('write rejected')})
  await m.db.runTransaction(async tx=>{
    await assert.rejects(tx.collection('x').doc('rejected').set({data:{value:1}}),/write rejected/)
    await tx.collection('x').doc('accepted').set({data:{value:2}})
  })
  assert.equal(m.report().totals.set,2)
  assert.equal(m.report().totals.acknowledgedWrites,1)
  assert.equal(f.documents('x').length,1)
})
