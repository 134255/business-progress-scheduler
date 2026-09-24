'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {runScenario,listScenarios,fieldRepositories,readReport,assertFieldViews}=require('../scenarios.cjs')
const {createCapacityFixture,NOW}=require('../fixtures.cjs')
const {createReadonlyDatabase}=require('../readonly-db.cjs')
const {normalizeFieldReportQuery}=require('../../../cloudfunctions/businessApi/lib/operations-field-analysis-query')
test('real smoke field sources are complete with zero writes',async()=>{
  const r=await runScenario({name:'field-summary',profile:'smoke'})
  assert.equal(r.outcome,'ok');assert.equal(r.complete,true);assert.equal(r.counts.sampledNodes,150)
  assert.equal(r.metrics.writeAttempts,0);assert.ok(r.metrics.maxTransactionOperations<=100)
})
test('monthly all-node request reports an existing limit, not capacity success',async()=>{
  const r=await runScenario({name:'field-summary',profile:'month',budgets:{maxMs:60000}})
  assert.equal(r.outcome,'known_limit');assert.equal(r.complete,false);assert.equal(r.counts.sampledNodes,null)
})
test('missing/valid/stale derived snapshots preserve counts; missing authority is incomplete',async()=>{
  const results=[]
  for(const name of ['field-summary','snapshot-valid','snapshot-stale','source-missing']) results.push(await runScenario({name,profile:'smoke'}))
  for(const r of results.slice(0,3)) assert.equal(r.counts.sampledNodes,150)
  assert.ok(results[1].metrics.reads<results[0].metrics.reads)
  assert.equal(results[3].outcome,'incomplete');assert.equal(results[3].complete,false)
})
test('full dashboard measures real business counts alongside reviews and unread messages',async()=>{
  for(const readPercent of [0,50,100]) {
    const r=await runScenario({name:`dashboard-10-read-${readPercent}`,profile:'smoke'})
    assert.equal(r.outcome,'ok');assert.equal(r.counts.pendingProcessing,10);assert.equal(r.counts.pendingReviews,10)
    assert.equal(r.counts.unreadNotifications,10*(100-readPercent)/100);assert.equal(r.metrics.writeAttempts,0)
  }
})
test('list pages preserve complete totals/tie order and previous evidence preserves every owner',async()=>{
  for(const page of [1,2,5]) {
    const r=await runScenario({name:`list-page-${page}`,profile:'smoke'})
    assert.equal(r.outcome,'ok');assert.equal(r.counts.rows,20);assert.equal(r.counts.totalRows,100)
  }
  for(const count of [0,6,40,94]) {
    const r=await runScenario({name:`previous-${count}`,profile:'smoke'})
    assert.equal(r.outcome,'ok');assert.equal(r.counts.rows,count);assert.ok(r.metrics.maxTransactionOperations<=100)
  }
})
test('independent concurrent accounts and 2495 linkage use real repositories',async()=>{
  for(const count of [10,20,50]) {
    const r=await runScenario({name:`isolation-${count}`,profile:'smoke'})
    assert.equal(r.outcome,'ok');assert.equal(r.counts.accounts,count);assert.equal(r.counts.isolationFailures,0)
  }
  const r=await runScenario({name:'linkage',profile:'smoke'})
  assert.equal(r.outcome,'ok');assert.equal(r.counts.sampledNodes,1);assert.ok(r.counts.rows>0)
})
test('v1/v2 complete traversals and cold continuation agree; changed sources and accounts deny release',async()=>{
  for(const reportVersion of [1,2]) {
    const f=createCapacityFixture({linesPerDay:1,nodesPerLine:1}),actor=f.actors[0]
    const h=createReadonlyDatabase({source:f}),repo=fieldRepositories(h.db)
    const range=normalizeFieldReportQuery({startDate:'2026-09-01',endDate:'2026-09-23',pageSize:2,
      ...(reportVersion===2?{reportVersion,analysis:{view:'catalog'}}:{})},NOW)
    const first=await repo.exportReportRows({actor,range})
    assert.equal(first.hasMore,true)
    const warm=await repo.exportReportRows({actor,range:{...range,cursor:first.nextCursor}})
    const cold=await fieldRepositories(h.db).exportReportRows({actor,range:{...range,cursor:first.nextCursor}})
    assert.deepEqual(warm.items,cold.items);assert.equal(warm.hasMore,cold.hasMore)
    const aggregate=await readReport(repo,{actor,range})
    assert.equal(aggregate.complete,true);assert.ok(aggregate.rows>2);assert.ok(aggregate.pages>1)
    const domain=require('../../../cloudfunctions/businessApi/lib/operations-field-domain')
    const node=f.entries('business_nodes').next().value
    const source={node,line:f.get('business_lines',node.businessLineId),feedback:f.get('node_feedback',node.latestFeedbackId),round:null,votes:[]}
    const final=domain.buildFinalFieldResult(source)
    const fieldRows=reportVersion===1?domain.fieldExportRows([final]):
      require('../../../cloudfunctions/businessApi/lib/operations-field-analysis').fieldAnalysisExportRows([
        {source,result:final,schema:domain.describeFieldAnalysisSource(source,final)}],range.analysis).rows
    assert.equal(aggregate.rows,1+fieldRows.length,'one real base node row plus complete domain field export')
    const other={...actor,_id:'second-admin'}
    h.replaceForTest('users',other._id,other)
    assert.ok((await repo.exportReportRows({actor:other,range})).items.length)
    await assert.rejects(repo.exportReportRows({actor:other,range:{...range,cursor:first.nextCursor}}),{code:'VALIDATION_ERROR'})
    const feedback=f.entries('node_feedback').next().value
    feedback.fieldValues.find(v=>v.fieldKey==='choice').value='B'
    h.replaceForTest('node_feedback',feedback._id,feedback)
    await assert.rejects(repo.exportReportRows({actor,range:{...range,cursor:first.nextCursor}}),{code:'REPORT_CHANGED'})
    h.replaceForTest('users',actor._id,{...actor,status:'disabled'})
    await assert.rejects(repo.exportReportRows({actor,range}),{code:'FORBIDDEN'})
    h.replaceForTest('users',actor._id,actor)
    h.replaceForTest('node_feedback',feedback._id,undefined)
    await assert.rejects(repo.exportReportRows({actor,range}),{code:'INCOMPLETE_FIELD_DATA'})
  }
})
test('invalid names rejected and measurement budgets never masquerade as completion',async()=>{
  assert.throws(()=>listScenarios('production'))
  await assert.rejects(runScenario({name:'unknown',profile:'smoke'}))
  const r=await runScenario({name:'field-summary',profile:'smoke',budgets:{maxReads:1}})
  assert.equal(r.outcome,'test_aborted');assert.equal(r.complete,false)
  assert.ok(!JSON.stringify(r).includes('feedback-'))
})
test('partial full report retains per-page versus cumulative read counts without claiming completion',async()=>{
  const r=await runScenario({name:'report-v1',profile:'smoke',budgets:{maxReads:2000}})
  assert.equal(r.outcome,'test_aborted');assert.equal(r.complete,false)
  assert.equal(r.counts.pages,1);assert.equal(r.counts.rows,50)
  assert.ok(r.counts.firstPageReads>0&&r.counts.firstPageReads<r.metrics.reads)
  assert.equal(r.counts.lastPageReads,r.counts.firstPageReads)
})

// Fault injection stays in this test process; no product file or CLI hook changes.
async function withFieldProbe(transform,run) {
  const modulePath=require.resolve('../../../cloudfunctions/businessApi/lib/cloud-operations-field-repository')
  const scenarioPath=require.resolve('../scenarios.cjs'),factory=require(modulePath)
  const original=factory.createCloudOperationsFieldRepository,saved=require.cache[scenarioPath]
  factory.createCloudOperationsFieldRepository=options=>transform(original(options),options.db)
  delete require.cache[scenarioPath]
  try {return await run(require('../scenarios.cjs'))}
  finally {factory.createCloudOperationsFieldRepository=original;require.cache[scenarioPath]=saved}
}
test('a swallowed write rejection still fails the read-only scenario',async()=>{
  await withFieldProbe((repo,db)=>({...repo,async getSummary(input){
    try {await db.collection('probe').doc('probe').set({data:{}})} catch {}
    return repo.getSummary(input)
  }}),async instrumented=>{
    const r=await instrumented.runScenario({name:'field-summary',profile:'smoke'})
    assert.equal(r.metrics.writeAttempts,1);assert.equal(r.outcome,'error');assert.equal(r.complete,false)
  })
})
test('three-way content checks reject missing summary, wrong analysis counts and equal-sized corrupt/duplicated export',async()=>{
  for(const mode of ['summary','analysis','report','duplicate']) await withFieldProbe(repo=>({...repo,
    async getSummary(input){const r=await repo.getSummary(input);if(mode==='summary') r.groups=[];return r},
    async getAnalysis(input){const r=await repo.getAnalysis(input);if(mode==='analysis'&&input.range.analysis.view==='node') r.items[0].options[0].count=999;return r},
    async exportReportRows(input){const r=await repo.exportReportRows(input);if(mode==='report') {
      const field=r.items.find(row=>row.recordType==='字段明细');if(field) field.fieldValue='corrupted same row count'
    };if(mode==='duplicate') {
      const indexes=r.items.flatMap((row,i)=>row.recordType==='字段明细'?[i]:[])
      if(indexes.length>1) r.items[indexes[1]]={...r.items[indexes[0]]}
    };return r}
  }),async instrumented=>{
    const r=await instrumented.runScenario({name:'linkage',profile:'smoke'})
    assert.equal(r.outcome,'error',mode);assert.equal(r.complete,false)
  })
})
test('distinct equal-sized authorized datasets cannot be swapped undetected',async()=>{
  await withFieldProbe(repo=>({...repo,async getSummary(input){
    const id=input.actor._id
    return repo.getSummary({...input,actor:{...input.actor,_id:id==='cap-member-00'?'cap-member-01':id==='cap-member-01'?'cap-member-00':id}})
  }}),async instrumented=>{
    const r=await instrumented.runScenario({name:'isolation-10',profile:'smoke'})
    assert.equal(r.outcome,'error');assert.equal(r.complete,false)
  })
})
test('small multiselect/empty/hidden/incompatible-name fixture matches every analysis option and CSV row',async()=>{
  const {fieldSource}=require('../../../cloudfunctions/businessApi/test/helpers/field-fixtures')
  const {arraySource}=require('../readonly-db.cjs')
  const source=fieldSource(),different=fieldSource({nodeId:'different',values:[{fieldKey:'choice',value:'A'},{fieldKey:'tags',value:['Y','Z']}]})
  different.node.fieldDefinitions[0].constraints.options.push('C')
  different.feedback.fieldValues.find(f=>f.fieldKey==='choice').value='C'
  const fields=[{fieldKey:'parent',name:'父项',sequence:0,type:'single_select',constraints:{options:['A','B']}},
    {fieldKey:'child',name:'子项',sequence:1,type:'single_select',constraints:{options:['X','Y']},
      condition:{parentFieldKey:'parent',visibleWhen:['A'],optionsByParentValue:{A:['X']}}}]
  const sources=[source,fieldSource({nodeId:'empty',values:[]}),different,
    fieldSource({nodeId:'hidden',node:{fieldDefinitions:fields},values:[{fieldKey:'parent',value:'B'}]}),
    fieldSource({nodeId:'visible',node:{fieldDefinitions:fields},values:[{fieldKey:'parent',value:'A'},{fieldKey:'child',value:'X'}]})]
  const line={...source.line,traversedNodeIds:sources.map(s=>s.node._id)}
  for(const s of sources) s.line=line
  const actor={_id:'root',role:'super_admin',status:'active'}
  const h=createReadonlyDatabase({source:arraySource({users:[actor],business_lines:[line],business_nodes:sources.map(s=>s.node),node_feedback:sources.map(s=>s.feedback)})})
  const checked=await assertFieldViews(fieldRepositories(h.db),{actor,sources,query:{startDate:'2026-09-01',endDate:'2026-09-23',pageSize:3}})
  const choices=checked.summary.groups.filter(g=>g.fieldKey==='choice')
  assert.equal(choices.length,2)
  assert.equal(choices.reduce((n,g)=>n+g.emptySampleCount,0),1)
  assert.deepEqual(checked.summary.groups.find(g=>g.fieldKey==='tags').options,
    [{label:'X',count:1},{label:'Y',count:2},{label:'Z',count:1}])
  const child=checked.summary.groups.find(g=>g.fieldKey==='child')
  assert.equal(child.filledSampleCount,1);assert.equal(child.emptySampleCount,0)
  assert.ok(checked.report.pages>1);assert.equal(checked.report.complete,true)
})
