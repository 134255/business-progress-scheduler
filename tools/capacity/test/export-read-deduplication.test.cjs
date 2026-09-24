'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {createReportProbe, reportSources, captureContract} = require('../report-probe.cjs')
const crypto=require('node:crypto')
const baseline=require('./fixtures/export-report-before-b1.json')
const {createProductSource}=require('../fixtures.cjs')
const {normalizeFieldReportQuery}=require('../../../cloudfunctions/businessApi/lib/operations-field-analysis-query')
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

for(const entry of baseline.cases) test(`frozen ordered rows and old cursor still work: ${entry.caseId}`,async()=>{
  const product=entry.caseId==='product-2495-v2'
  const [mode,versionText]=entry.caseId.split('-v'),version=product?2:Number(versionText)
  const sources=product?[createProductSource()]:reportSources(1,mode)
  const p=createReportProbe({sources,realBase:true}),before=entry.result,after=await captureContract(p,version)
  assert.equal(after.rowsDigest,before.rowsDigest)
  assert.equal(after.rowCount,before.rowCount)
  assert.deepEqual(after.firstCursorBody,before.firstCursorBody)
  for(const key of ['firstPageReads','warmPageReads','coldPageReads']) {
    assert.equal(before[key]-after[key],!product&&mode!=='none'?4:3)
  }
  for(const key of ['firstPageTransactions','warmPageTransactions','coldPageTransactions','maxTransactionOperations']) {
    assert.equal(after[key],before[key])
  }
  const oldCursor=p.codec.encode(before.firstCursorBody)
  const continued=await p.freshRepository().exportReportRows({actor:p.actor,range:{...p.range(version),cursor:oldCursor}})
  const current=await p.freshRepository().exportReportRows({actor:p.actor,
    range:{...p.range(version),cursor:p.codec.encode(after.firstCursorBody)}})
  assert.deepEqual(continued.items,current.items)
  assert.equal(continued.hasMore,current.hasMore)
  assert.equal(p.metrics().writeAttempts,0)
})
for(const entry of baseline.nonReport) test(`non-report output and reads unchanged: ${entry.mode}/${entry.method}`,async()=>{
  const p=createReportProbe({sources:reportSources(1,entry.mode),realBase:true})
  const result=await p.repository[entry.method]({actor:p.actor,range:p.range(2,50)})
  assert.equal(hash(result),entry.resultDigest)
  assert.equal(hash(p.trace),entry.traceDigest)
  assert.deepEqual(p.metrics(),entry.metrics)
})
test('old cursors still reject another account, changed query and expiry',async()=>{
  const p=createReportProbe({realBase:true}),body=baseline.cases.find(c=>c.caseId==='none-v2').result.firstCursorBody
  const range={...p.range(2),cursor:p.codec.encode(body)}
  const other={...p.actor,_id:'other-admin'}
  p.replace('users',other._id,other)
  await assert.rejects(p.freshRepository().exportReportRows({actor:other,range}),{code:'VALIDATION_ERROR'})
  await assert.rejects(p.freshRepository().exportReportRows({actor:p.actor,range:{...range,status:'completed'}}),{code:'VALIDATION_ERROR'})
  p.advanceClock(20*60*1000)
  await assert.rejects(p.freshRepository().exportReportRows({actor:p.actor,range}),{code:'REPORT_EXPIRED'})
})
test('evicted report cursor rebuilds the same next rows',async()=>{
  let collects=0,validations=0
  const p=createReportProbe({realBase:true,hook({stage}){stage==='collect'?collects++:validations++}})
  const ranges=[20,21,22,23].map(day=>normalizeFieldReportQuery({startDate:'2026-09-01',endDate:`2026-09-${day}`,
    pageSize:2,reportVersion:2,analysis:{view:'catalog'}},new Date('2026-09-24T04:00:00Z')))
  const first=await p.repository.exportReportRows({actor:p.actor,range:ranges[0]})
  const continuation={...ranges[0],cursor:first.nextCursor}
  const expected=await p.repository.exportReportRows({actor:p.actor,range:continuation})
  for(const range of ranges.slice(1)) await p.repository.exportReportRows({actor:p.actor,range})
  const actual=await p.repository.exportReportRows({actor:p.actor,range:continuation})
  assert.deepEqual(actual.items,expected.items)
  assert.equal(actual.hasMore,expected.hasMore)
  assert.equal(collects,5)
  assert.equal(validations,1)
  assert.equal(p.metrics().writeAttempts,0)
})
test('empty complete report has neither rows nor continuation',async()=>{
  const p=createReportProbe({sources:[],realBase:true})
  assert.deepEqual(await p.repository.exportReportRows({actor:p.actor,range:p.range(2)}),{items:[],hasMore:false,nextCursor:''})
})
test('row and byte budgets refuse oversized reports but permit exactly 50000 rows',async()=>{
  for(const makeRows of [()=>Array.from({length:50001},()=>({})),()=>[{payload:'x'.repeat(13*1024*1024)}]]) {
    const p=createReportProbe({baseRows:makeRows()})
    await assert.rejects(p.repository.exportReportRows({actor:p.actor,range:p.range()}),{code:'RANGE_TOO_LARGE'})
    assert.equal(p.metrics().writeAttempts,0)
  }
  // The frozen single-node v1 fixture has 12 field/option rows (13 with its base row).
  const p=createReportProbe({baseRows:Array.from({length:50000-12},()=>({}))})
  const page=await p.repository.exportReportRows({actor:p.actor,range:p.range(1,50)})
  assert.equal(page.items.length,50)
  assert.equal(page.hasMore,true)
  assert.equal(p.metrics().writeAttempts,0)
})
test('creation and completion dates keep their separate report scopes across months',async()=>{
  const sources=reportSources(2)
  sources[0].line.createdAt=new Date('2026-08-31T01:00:00Z')
  sources[1].node.completedAt=new Date('2026-10-01T01:00:00Z')
  const p=createReportProbe({sources,realBase:true})
  const page=await p.repository.exportReportRows({actor:p.actor,range:p.range(1,50)})
  assert.equal(page.hasMore,false)
  assert.deepEqual(page.items.filter(r=>r.recordType==='运营基础').map(r=>r.businessCode),['PROBE-1'])
  const fields=page.items.filter(r=>r.recordType==='字段明细')
  assert.equal(fields.length,7)
  assert.deepEqual([...new Set(fields.map(r=>r.businessCode))],['PROBE-0'])
  assert.ok(fields.every(r=>r.dateBasis==='节点完成日期'))
  assert.equal(p.metrics().writeAttempts,0)
})

for(const mode of ['none','any','all']) test(`unrelated pending round failure cannot block complete report: ${mode}`,async()=>{
  const fault=Object.assign(new Error('SYNTHETIC_READ_FAILURE'),{code:'SYNTHETIC_READ_FAILURE'})
  const p=createReportProbe({sources:reportSources(1,mode),realBase:true,beforeRead(op){
    if(op.collection==='node_review_rounds'&&op.id===undefined) throw fault
  }})
  const page=await p.repository.exportReportRows({actor:p.actor,range:p.range()})
  assert.equal(page.items.length,2)
  assert.equal(p.trace.filter(op=>op.collection==='node_review_rounds'&&op.id!==undefined).length,mode==='none'?0:3)
  await assert.rejects(p.operationsRepository.getDashboard({actor:p.actor,range:p.range()}),e=>e===fault)
  await assert.rejects(p.operationsRepository.exportRows({actor:p.actor,range:p.range()}),e=>e===fault)
  assert.equal(p.metrics().writeAttempts,0)
})
test('related final round read failure still blocks the complete report',async()=>{
  const fault=new Error('SYNTHETIC_ROUND_READ_FAILURE')
  const p=createReportProbe({sources:reportSources(1,'any'),realBase:true,beforeRead(op){
    if(op.collection==='node_review_rounds'&&op.id!==undefined) throw fault
  }})
  await assert.rejects(p.repository.exportReportRows({actor:p.actor,range:p.range()}),e=>e===fault)
})
for(const change of ['timing','lineAdded','lineRemoved','nodeAdded','nodeRemoved','historicalName']) {
  test(`base manifest still discovers ${change}`,async()=>{
    const sources=reportSources()
    if(change==='historicalName') delete sources[0].node.processorDisplayNames
    const p=createReportProbe({sources,realBase:true}),s=sources[0]
    const input={actor:p.actor,range:p.range()}
    const base=await p.operationsRepository.collectReportBase(input)
    if(change==='timing') p.replace('business_nodes',s.node._id,{...s.node,processingElapsedWorkMinutes:125})
    if(change==='lineAdded') p.replace('business_lines','new-line',{...s.line,_id:'new-line'})
    if(change==='lineRemoved') p.replace('business_lines',s.line._id,undefined)
    if(change==='nodeAdded') {
      p.replace('business_lines',s.line._id,{...s.line,traversedNodeIds:[...s.line.traversedNodeIds,'new-node']})
      p.replace('business_nodes','new-node',{...s.node,_id:'new-node',sequence:1})
    }
    if(change==='nodeRemoved') p.replace('business_nodes',s.node._id,undefined)
    if(change==='historicalName') p.replace('users','processor-1',{_id:'processor-1',role:'user',status:'active',displayName:'新的合成显示名'})
    await assert.rejects(p.operationsRepository.validateReportBase({...input,manifest:base.manifest}),{code:'REPORT_CHANGED'})
    assert.equal(p.metrics().writeAttempts,0)
  })
}

const changes={
  feedbackValue(p,s) {
    const f=structuredClone(s.feedback)
    f.fieldValues.find(v=>v.fieldKey==='choice').value='B'
    p.replace('node_feedback',f._id,f)
  },
  feedbackIdentity(p,s) {
    const f={...s.feedback,_id:'replacement-feedback',revision:3}
    p.replace('node_feedback',f._id,f)
    p.replace('business_nodes',s.node._id,{...s.node,latestFeedbackId:f._id,latestFeedbackRevision:3})
  },
  feedbackRemoved(p,s) {p.replace('node_feedback',s.feedback._id,undefined)},
  nodeRemoved(p,s) {p.replace('business_nodes',s.node._id,undefined)},
  roundIdentity(p,s) {
    const r={...s.round,_id:'replacement-round'}
    p.replace('node_review_rounds',r._id,r)
    p.replace('business_nodes',s.node._id,{...s.node,lastReviewRoundId:r._id})
  },
  roundRemoved(p,s) {p.replace('node_review_rounds',s.round._id,undefined)},
  voteAdded(p,s) {p.replace('node_review_votes','extra-vote',{...s.votes[0],_id:'extra-vote',reviewerUserId:'reviewer-2'})},
  voteRemoved(p,s) {p.replace('node_review_votes',s.votes[0]._id,undefined)},
  voteReplaced(p,s) {
    p.replace('node_review_votes',s.votes[0]._id,undefined)
    p.replace('node_review_votes','replacement-vote',{...s.votes[0],_id:'replacement-vote'})
  },
  voteRejected(p,s) {p.replace('node_review_votes',s.votes[0]._id,{...s.votes[0],decision:'rejected'})}
}
for(const mode of ['none','any','all']) for(const stage of ['collect','validate']) {
  for(const [name,change] of Object.entries(changes)) {
    if(mode==='none'&&(name.startsWith('round')||name.startsWith('vote'))) continue
    test(`tail rejects ${name} during ${stage}, ${mode}`,async()=>{
      const p=createReportProbe({sources:reportSources(1,mode),hook:event=>{
        if(event.stage===stage) change(event.probe,event.probe.sources[0])
      }})
      let range=p.range(2)
      if(stage==='validate') {
        const first=await p.repository.exportReportRows({actor:p.actor,range})
        range={...range,cursor:first.nextCursor}
      }
      await assert.rejects(p.repository.exportReportRows({actor:p.actor,range}),{code:'REPORT_CHANGED'})
      assert.equal(p.metrics().writeAttempts,0)
    })
  }
}
for(const mode of ['any','all']) for(const stage of ['collect','validate']) {
  test(`new vote scan retains its 50 vote bound: ${stage}/${mode}`,async()=>{
    const p=createReportProbe({sources:reportSources(1,mode),hook:event=>{
      if(event.stage!==stage) return
      const s=event.probe.sources[0]
      for(let i=s.votes.length;i<51;i++) event.probe.replace('node_review_votes',`extra-${i}`,{...s.votes[0],_id:`extra-${i}`})
    }})
    let range=p.range()
    if(stage==='validate') range={...range,cursor:(await p.repository.exportReportRows({actor:p.actor,range})).nextCursor}
    await assert.rejects(p.repository.exportReportRows({actor:p.actor,range}),{code:'RANGE_TOO_LARGE'})
    assert.equal(p.metrics().writeAttempts,0)
  })
}
for(const stage of ['collect','validate']) for(const change of [{status:'disabled'},{role:'user'}]) {
  test(`revocation during ${stage} ${JSON.stringify(change)} denies report`,async()=>{
    const p=createReportProbe({hook:event=>{
      if(event.stage===stage) event.probe.replace('users','root',{...event.probe.actor,...change})
    }})
    let range=p.range(2)
    if(stage==='validate') range={...range,cursor:(await p.repository.exportReportRows({actor:p.actor,range})).nextCursor}
    await assert.rejects(p.repository.exportReportRows({actor:p.actor,range}),{code:'FORBIDDEN'})
    assert.equal(p.metrics().writeAttempts,0)
  })
}
test('last line reauthorization sees revocation after final result transactions',async()=>{
  let afterBase=false,revoked=false
  const p=createReportProbe({hook(){afterBase=true},beforeRead(op,probe){
    if(afterBase&&!revoked&&op.collection==='users'&&!op.transaction) {
      revoked=true;probe.replace('users','root',{...probe.actor,status:'disabled'})
    }
  }})
  await assert.rejects(p.repository.exportReportRows({actor:p.actor,range:p.range()}),{code:'FORBIDDEN'})
  assert.equal(revoked,true)
  assert.equal(p.metrics().writeAttempts,0)
})
for(const tail of [false,true]) test(`unknown feedback read failure remains a failure: tail=${tail}`,async()=>{
  const fault=Object.assign(new Error('SYNTHETIC_READ_FAILURE'),{code:'SYNTHETIC_READ_FAILURE'})
  let afterBase=false
  const p=createReportProbe({hook(){afterBase=true},beforeRead(op){
    if(op.collection==='node_feedback'&&(!tail||afterBase)) throw fault
  }})
  await assert.rejects(p.repository.exportReportRows({actor:p.actor,range:p.range()}),e=>e===fault)
  assert.equal(p.metrics().writeAttempts,0)
})

for(const mode of ['none','any','all']) for(const version of [1,2]) {
  test(`tail avoids outside pre-read but verifies authority: ${mode}/${version}`,async()=>{
    const p=createReportProbe({sources:reportSources(1,mode)})
    await p.repository.exportReportRows({actor:p.actor,range:p.range(version)})
    const count=(name,tx,document)=>p.trace.filter(op=>op.collection===name&&
      op.transaction===tx&&(op.id!==undefined)===document).length
    assert.equal(count('business_nodes',false,true),0)
    assert.equal(count('node_feedback',false,true),1)
    assert.equal(count('node_feedback',true,true),2)
    assert.equal(count('node_review_rounds',false,true),mode==='none'?0:1)
    assert.equal(count('node_review_votes',false,false),mode==='none'?0:2)
    assert.equal(p.metrics().writeAttempts,0)
  })
}

test('probe preserves real source contracts with zero writes', async () => {
  for (const mode of ['none','any','all']) {
    const p = createReportProbe({sources:reportSources(1,mode),realBase:true})
    const result = await captureContract(p,2)
    assert.ok(result.rowCount > 2)
    assert.match(result.rowsDigest,/^[a-f0-9]{64}$/)
    assert.equal(p.metrics().writeAttempts,0)
    assert.ok(p.metrics().maxTransactionOperations <= 100)
  }
})
