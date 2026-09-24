'use strict'
const assert=require('node:assert/strict')
const {isDeepStrictEqual}=require('node:util')
const {NOW,createCapacityFixture,createProductSource}=require('./fixtures.cjs')
const {createReadonlyDatabase,arraySource}=require('./readonly-db.cjs')
const {createWorkspaceFixture}=require('./workspace-fixtures.cjs')
const {createCloudOperationsRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-repository')
const {createCloudOperationsFieldRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-field-repository')
const {createCloudBusinessRepository}=require('../../cloudfunctions/businessApi/lib/cloud-business-repository')
const {createCloudFeedbackRepository}=require('../../cloudfunctions/businessApi/lib/cloud-feedback-repository')
const {createBusinessService}=require('../../cloudfunctions/businessApi/lib/business-service')
const {createCloudReviewRepository}=require('../../cloudfunctions/businessApi/lib/cloud-review-repository')
const {createReviewService}=require('../../cloudfunctions/businessApi/lib/review-service')
const {createDashboardWorkspaceService}=require('../../cloudfunctions/businessApi/lib/dashboard-workspace-service')
const {createPreviousNodeResultRepository}=require('../../cloudfunctions/businessApi/lib/previous-node-result-repository')
const {normalizeFieldQuery}=require('../../cloudfunctions/businessApi/lib/operations-field-query')
const {normalizeAnalysisQuery,normalizeFieldReportQuery}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis-query')
const fieldDomain=require('../../cloudfunctions/businessApi/lib/operations-field-domain')
const {buildFieldAnalysis,fieldAnalysisExportRows}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis')
const {safeOperationsRow}=require('../../cloudfunctions/businessApi/lib/operations-domain')
const PROFILES=Object.freeze({smoke:1,month:30,'half-year':180,year:365})
const FIELD_NAMES=['field-summary','field-single-node','field-analysis','field-filters','report-v1','report-v2','history-growth']
const SMALL_NAMES=['snapshot-valid','snapshot-stale','source-missing','linkage',
  ...[0,10,50,100].flatMap(n=>[0,50,100].map(p=>`dashboard-${n}-read-${p}`)),
  ...[1,2,5].map(p=>`list-page-${p}`),...[0,6,40,94].map(n=>`previous-${n}`),...[10,20,50].map(n=>`isolation-${n}`)]
const coded=code=>Object.assign(new Error(code),{code})
function listScenarios(profile='smoke') {
  if(!Object.hasOwn(PROFILES,profile)) throw coded('INVALID_PROFILE')
  return [...FIELD_NAMES,...(profile==='smoke'?SMALL_NAMES:[])].map(name=>({name,profile}))
}
function fieldRepositories(db) {
  return createCloudOperationsFieldRepository({db,operationsRepository:createCloudOperationsRepository({db}),
    secret:'capacity-local-only-'.repeat(4),clock:()=>new Date(NOW)})
}
const bytes=value=>Buffer.byteLength(JSON.stringify(value))
async function readReport(repository,{actor,range},progress=()=>{},onPage=()=>{}) {
  let cursor='',pages=0,rows=0,responseBytes=0
  const cursors=new Set()
  do {
    const page=await repository.exportReportRows({actor,range:{...range,cursor}})
    if(!Array.isArray(page.items)||typeof page.hasMore!=='boolean'||page.hasMore!==!!page.nextCursor||
      page.hasMore&&(!page.items.length||cursors.has(page.nextCursor))) throw coded('INVALID_REPORT_PAGE')
    onPage(page.items)
    pages++;rows+=page.items.length;responseBytes+=bytes(page)
    progress({pages,rows,responseBytes,complete:!page.hasMore})
    if(!page.hasMore) return {pages,rows,responseBytes,complete:true}
    cursor=page.nextCursor;cursors.add(cursor)
  } while(true)
}
// Small correctness oracle only. Large measurements never retain a full report.
async function assertFieldViews(repository,{sources,actor,query}) {
  assert.ok(sources.length>0&&sources.length<=10)
  const records=sources.map(source=>{
    const result=fieldDomain.buildFinalFieldResult(source)
    return {source,result,schema:fieldDomain.describeFieldAnalysisSource(source,result)}
  })
  const results=records.map(r=>r.result)
  const summary=await repository.getSummary({actor,range:normalizeFieldQuery(query,NOW)})
  assert.equal(summary.incomplete,false);assert.equal(summary.sampledNodeCount,results.length)
  assert.deepEqual(summary.groups,fieldDomain.aggregateFieldResults(results))
  const analyses=[{view:'catalog'},...[...new Set(records.map(r=>r.schema.nodeGroupId))].map(nodeGroupId=>({view:'node',nodeGroupId}))]
  for(const analysis of analyses) {
    const range=normalizeAnalysisQuery({...query,pageSize:50,analysis},NOW)
    const expected=buildFieldAnalysis(records,range.analysis),actual=await repository.getAnalysis({actor,range})
    assert.equal(actual.incomplete,false);assert.equal(actual.hasMore,false)
    for(const key of ['view','items','sampleCount','filledSampleCount','emptySampleCount','notApplicableSampleCount',
      'dimensionMetadata','linkages','productStage','context']) assert.deepEqual(actual[key],expected[key])
  }
  let report
  for(const reportVersion of [1,2]) {
    const range=normalizeFieldReportQuery({...query,...(reportVersion===2?{reportVersion,analysis:{view:'catalog'}}:{})},NOW)
    const base=sources.slice().sort((a,b)=>String(b.line.createdAt).localeCompare(String(a.line.createdAt)) ||
      a.line._id.localeCompare(b.line._id) || a.node.sequence-b.node.sequence || a.node._id.localeCompare(b.node._id))
      .map(({line,node})=>({...safeOperationsRow({line,node,processorDisplayNames:node.processorDisplayNames,reviewerDisplayNames:node.reviewerDisplayNames}),
        recordType:'运营基础',dateBasis:'售后创建日期',...(reportVersion===2?{analysisContextJson:JSON.stringify({dateBasis:'售后创建日期',analysisApplied:false})}:{})}))
    const expected=[...base,...(reportVersion===1?fieldDomain.fieldExportRows(results):fieldAnalysisExportRows(records,range.analysis).rows)]
    const observed=[]
    report=await readReport(repository,{actor,range},()=>{},items=>{
      observed.push(...items);assert.ok(observed.length<=expected.length)
    })
    assert.deepEqual(observed.slice(0,base.length),base)
    // Field groups may follow a repository scan order. Compare full row multisets,
    // retaining duplicates, rather than accidentally requiring fixture input order.
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
      Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
    const rows=values=>values.map(value=>JSON.stringify(canonical(value))).sort()
    assert.deepEqual(rows(observed),rows(expected))
  }
  return {summary,report}
}
function outcomeFor(error) {
  if(error?.code==='RANGE_TOO_LARGE') return 'known_limit'
  if(['INCOMPLETE_FIELD_DATA','FIELD_SOURCE_INVALID'].includes(error?.code)) return 'incomplete'
  if(['MEASUREMENT_BUDGET','TRANSACTION_BUDGET'].includes(error?.code)) return 'test_aborted'
  return 'error'
}
async function runScenario({name,profile='smoke',budgets={}}) {
  if(!listScenarios(profile).some(s=>s.name===name)) throw coded('INVALID_SCENARIO')
  const result={schemaVersion:1,scenario:name,profile,measurement:'local-synthetic',outcome:'error',complete:false,
    counts:{sampledNodes:null,responseBytes:null,pages:null,rows:null},metrics:null}
  let h
  const database=source=>(h=createReadonlyDatabase({source,...budgets}))
  const finish=(value,counts={})=>{Object.assign(result.counts,{responseBytes:bytes(value)},counts)
    result.complete=value.incomplete!==true && value.complete!==false && value.stats?.complete!==false
    result.outcome=result.complete?'ok':'incomplete'}
  try {
    if(name.startsWith('dashboard-')||name.startsWith('list-')||name.startsWith('previous-')) {
      const dashboard=/^dashboard-(\d+)-read-(\d+)$/.exec(name),list=/^list-page-(\d+)$/.exec(name),previous=/^previous-(\d+)$/.exec(name)
      const f=createWorkspaceFixture({kind:dashboard?'dashboard':list?'list':'previous',count:dashboard?+dashboard[1]:list?100:+previous[1],readPercent:dashboard?+dashboard[2]:50})
      database(arraySource(f.seed))
      const workTimeService={tryAddWorkMinutes:()=>{throw coded('UNEXPECTED_DEPENDENCY')},workingMinutesBetween:()=>{throw coded('UNEXPECTED_DEPENDENCY')}}
      const business=createCloudBusinessRepository({db:h.db,workTimeService})
      if(dashboard) {
        const workspace=createDashboardWorkspaceService({businessService:createBusinessService({repository:business,workTimeService}),
          reviewService:createReviewService({reviewRepository:createCloudReviewRepository({db:h.db}),feedbackRepository:createCloudFeedbackRepository({db:h.db}),workTimeService})})
        const v=await workspace.getDashboardWorkspace(f.input)
        finish(v,{pendingProcessing:v.stats.pendingMine,pendingReviews:v.stats.pendingReviews,unreadNotifications:v.stats.unreadNotifications})
      } else if(list) {
        const v=await business.listBusinessLines({actor:f.actor,query:{page:+list[1],pageSize:20}})
        assert.deepEqual(v.items.map(x=>x._id),Array.from({length:20},(_,i)=>`line-${String((+list[1]-1)*20+i).padStart(4,'0')}`))
        finish(v,{pages:1,rows:v.items.length,totalRows:v.total})
      } else {
        const v=await createPreviousNodeResultRepository({db:h.db,businessRepository:business}).getPreviousNodeResult(f.input)
        assert.equal(v.evidences.length,+previous[1]);finish(v,{rows:v.evidences.length})
      }
    } else if(name.startsWith('isolation-')) {
      const accounts=+name.split('-')[1],f=createCapacityFixture({linesPerDay:2,nodesPerLine:1})
      const seed=Object.fromEntries(f.collections.map(name=>[name,[...f.entries(name)]]))
      // Same-sized disjoint memberships intentionally have different values.
      seed.node_feedback.forEach((feedback,i)=>{
        feedback.fieldValues.find(v=>v.fieldKey==='choice').value=i?'B':'A'
        feedback.fieldValues.find(v=>v.fieldKey==='tags').value=i?['Z']:['X','Y']
      })
      const sources=seed.business_nodes.map(node=>({node,line:seed.business_lines.find(l=>l._id===node.businessLineId),
        feedback:seed.node_feedback.find(f=>f._id===node.latestFeedbackId),round:null,votes:[]}))
      const finals=sources.map(fieldDomain.buildFinalFieldResult)
      database(arraySource(seed))
      const range=normalizeFieldQuery({startDate:'2026-09-01',endDate:'2026-09-23'},NOW)
      const responses=await Promise.all(f.actors.slice(0,accounts).map(actor=>fieldRepositories(h.db).getSummary({actor,range})))
      const failures=responses.filter((r,i)=>{
        const expected=i<5?finals:i<7?[finals[i-5]]:[]
        return r.incomplete || r.sampledNodeCount!==expected.length || !isDeepStrictEqual(r.groups,fieldDomain.aggregateFieldResults(expected))
      }).length
      Object.assign(result.counts,{accounts,isolationFailures:failures})
      assert.equal(failures,0)
      finish(responses,{accounts,isolationFailures:failures,rows:responses.length})
    } else if(name==='linkage') {
      const source=createProductSource(),actor={_id:'root',role:'super_admin',status:'active'}
      database(arraySource({users:[actor],business_lines:[source.line],business_nodes:[source.node],node_feedback:[source.feedback]}))
      const repo=fieldRepositories(h.db),q={startDate:'2026-09-01',endDate:'2026-09-23',pageSize:50}
      const {report}=await assertFieldViews(repo,{actor,sources:[source],query:q})
      finish(report,{...report,sampledNodes:1});delete result.counts.complete
    } else {
      const f=createCapacityFixture({days:PROFILES[profile],snapshotMode:name==='snapshot-valid'?'valid':name==='snapshot-stale'?'stale':'missing'})
      database(f)
      if(name==='source-missing') h.replaceForTest('node_feedback','feedback-cap-node-000000-0',undefined)
      const actor=f.actors[0],repo=fieldRepositories(h.db)
      const query={startDate:name==='history-growth'?'2026-09-23':'2026-08-25',endDate:'2026-09-23',pageSize:50,
        ...(name==='field-single-node'?{stableNodeId:'stable-node-0'}:{})}
      if(name.startsWith('report-')) {
        const range=normalizeFieldReportQuery({...query,...(name==='report-v2'?{reportVersion:2,analysis:{view:'catalog'}}:{})},NOW)
        let previousReads=0
        const report=await readReport(repo,{actor,range},p=>{
          const {complete,...counts}=p,currentReads=h.metrics().reads
          Object.assign(result.counts,counts,{lastPageReads:currentReads-previousReads})
          if(p.pages===1) result.counts.firstPageReads=currentReads
          previousReads=currentReads
        })
        finish(report,report);delete result.counts.complete
      } else {
        const v=name==='field-analysis'?await repo.getAnalysis({actor,range:normalizeAnalysisQuery({...query,analysis:{view:'catalog'}},NOW)}):
          name==='field-filters'?await repo.getFilters({actor,range:normalizeFieldQuery(query,NOW)}):
            await repo.getSummary({actor,range:normalizeFieldQuery(query,NOW)})
        finish(v,{sampledNodes:v.sampledNodeCount??v.sampleCount??null})
      }
    }
  } catch(error) {result.outcome=outcomeFor(error);result.complete=false}
  result.metrics=h?.metrics()||null
  if(result.metrics?.writeAttempts>0) {result.outcome='error';result.complete=false}
  return result
}
module.exports={PROFILES,listScenarios,runScenario,fieldRepositories,readReport,outcomeFor,assertFieldViews}
