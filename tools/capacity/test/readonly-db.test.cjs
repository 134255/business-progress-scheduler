'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createReadonlyDatabase,arraySource}=require('../readonly-db.cjs')
const {createFakeCloudDatabase}=require('../../../cloudfunctions/businessApi/test/helpers/fake-cloud-database')
const seed={rows:Array.from({length:45},(_,i)=>({_id:String(i).padStart(3,'0'),n:i,members:[i%2?'one':'two'],
  day:i%3?'2026-09-01':'2026-09-02',at:i%2?new Date('2026-09-01T00:00:00Z'):'2026-09-01T00:00:00Z'}))}
test('query subset matches existing local oracle including ties, keysets and date type semantics',async()=>{
  const h=createReadonlyDatabase({source:arraySource(seed)}),fake=createFakeCloudDatabase(seed).db
  const criteria=db=>[{}, {members:'one'}, {_id:db.command.gt('020')}, {n:db.command.and(db.command.gte(12),db.command.lte(30))},
    {n:db.command.lt(4)},{n:db.command.eq(3)},{n:db.command.in([1,9,30])},{at:db.command.eq(new Date('2026-09-01T00:00:00Z'))},
    {at:db.command.eq('2026-09-01T00:00:00Z')},{at:db.command.gte(new Date('2026-09-01T00:00:00Z'))},{missing:'none'}]
  for(let i=0;i<criteria(fake).length;i++) for(const offset of [0,20,40,60]) {
    const query=db=>db.collection('rows').where(criteria(db)[i]).orderBy('day','desc').orderBy('_id','asc').skip(offset).limit(20)
    assert.deepEqual(await query(h.db).get(),await query(fake).get())
    assert.deepEqual(await query(h.db).count(),await query(fake).count())
  }
  assert.equal(h.metrics().reads,11*4*2)
  assert.equal(h.metrics().writeAttempts,0)
})
test('every exposed write fails closed, unsupported queries and invalid bounds rejected',async()=>{
  const h=createReadonlyDatabase({source:arraySource(seed)})
  const col=h.db.collection('rows'),doc=col.doc('000')
  for(const write of [()=>doc.set({data:{}}),()=>doc.update({data:{}}),()=>doc.remove(),()=>col.add({data:{}}),()=>col.update({data:{}}),()=>col.remove(),()=>h.db.serverDate()])
    await assert.rejects(async()=>write(),{code:'READONLY_VIOLATION'})
  assert.equal(h.metrics().writeAttempts,7)
  for(const operation of [()=>col.skip(-1),()=>col.limit(NaN),()=>col.limit(0),()=>col.orderBy('n','invalid'),()=>col.where({n:{__operator:'mystery'}}),()=>col.aggregate(),()=>h.db.command.or({})])
    assert.throws(operation,{code:'UNSUPPORTED_QUERY'})
  for(const options of [{maxReads:0},{maxMs:NaN},{maxHeapBytes:Infinity}]) assert.throws(()=>createReadonlyDatabase({source:arraySource(seed),...options}))
})
test('fixed document transactions freeze overlay generation; returned values are isolated',async()=>{
  const h=createReadonlyDatabase({source:arraySource(seed)})
  await h.db.runTransaction(async tx=>{
    const a=await tx.collection('rows').doc('000').get()
    h.replaceForTest('rows','000',{_id:'000',n:999})
    a.data.n=777
    assert.equal((await tx.collection('rows').doc('000').get()).data.n,0)
  })
  assert.equal((await h.db.collection('rows').doc('000').get()).data.n,999)
  await assert.rejects(h.db.runTransaction(tx=>tx.collection('rows').where({}).get()),{code:'TRANSACTION_QUERY_FORBIDDEN'})
  await assert.rejects(h.db.collection('rows').doc('missing').get(),/does not exist/)
  assert.equal(h.metrics().maxTransactionOperations,2)
})
test('read, transaction, clock and heap budgets abort without writes',async()=>{
  const h=createReadonlyDatabase({source:arraySource(seed),maxReads:1})
  await h.db.collection('rows').get()
  await assert.rejects(h.db.collection('rows').get(),{code:'MEASUREMENT_BUDGET'})
  const txh=createReadonlyDatabase({source:arraySource(seed)})
  await assert.rejects(txh.db.runTransaction(async tx=>{for(let i=0;i<101;i++) await tx.collection('rows').doc('000').get()}),{code:'TRANSACTION_BUDGET'})
  const low=createReadonlyDatabase({source:arraySource(seed),maxHeapBytes:1})
  await assert.rejects(low.db.collection('rows').get(),{code:'MEASUREMENT_BUDGET'})
  const slow=createReadonlyDatabase({source:arraySource(seed),maxMs:1,beforeRead:()=>new Promise(r=>setTimeout(r,10))})
  await assert.rejects(slow.db.collection('rows').get(),{code:'MEASUREMENT_BUDGET'})
})
test('count is a logical query, not returned documents; parallel reads are measured',async()=>{
  const h=createReadonlyDatabase({source:arraySource(seed)})
  assert.equal((await h.db.collection('rows').count()).total,45)
  assert.equal(h.metrics().returnedRows,0)
  await Promise.all([1,2,3].map(()=>h.db.collection('rows').limit(1).get()))
  assert.equal(h.metrics().peakActiveReads,3)
  assert.equal(h.metrics().returnedRows,3)
  assert.ok(Object.values(h.metrics()).every(Number.isFinite))
})
