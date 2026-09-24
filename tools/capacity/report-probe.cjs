'use strict'
// Offline integration probe. Uses persisted synthetic sources and real repositories.
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const {fieldSource}=require('../../cloudfunctions/businessApi/test/helpers/field-fixtures')
const domain=require('../../cloudfunctions/businessApi/lib/operations-field-domain')
const {createReadonlyDatabase,arraySource}=require('./readonly-db.cjs')
const {createCloudOperationsRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-repository')
const {createCloudOperationsFieldRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-field-repository')
const {createOperationsReportCursor}=require('../../cloudfunctions/businessApi/lib/operations-report-cursor')
const {normalizeFieldReportQuery}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis-query')
const PROBE_SECRET='synthetic-b1-only-'.repeat(4)

function reportSources(count=1,mode='none') {
  if(!Number.isSafeInteger(count)||count<1||count>150||!['none','any','all'].includes(mode)) throw new Error('INVALID_PROBE_INPUT')
  return Array.from({length:count},(_,i)=>{
    const s=fieldSource({nodeId:`probe-node-${i}`,reviewed:mode!=='none',line:{_id:`probe-line-${i}`,code:`PROBE-${i}`}})
    if(mode==='all') {
      s.node.reviewMode='all';s.round.reviewMode='all'
      s.round.approvedVoteCount=2;s.round.voteCount=2
      s.votes.push({...s.votes[0],_id:`probe-second-vote-${i}`,reviewerUserId:'reviewer-2',reviewerDisplayName:'合成审核人二'})
    }
    if(!domain.buildFinalFieldResult(s)) throw new Error('INVALID_PROBE_SOURCE')
    return s
  })
}

function createReportProbe({sources=reportSources(),realBase=false,baseRows=[],hook=()=>{},beforeRead=()=>{}}={}) {
  const actor={_id:'root',role:'super_admin',status:'active',displayName:'合成管理员'}
  const ids=new Set(sources.flatMap(s=>[...s.node.processorUserIds,...s.node.reviewerUserIds]))
  const people=[...ids].filter(id=>id!==actor._id).map(_id=>({_id,role:'user',status:'active',displayName:'合成人员'}))
  const seed={users:[actor,...people],business_lines:[...new Map(sources.map(s=>[s.line._id,s.line])).values()],
    business_nodes:sources.map(s=>s.node),node_feedback:sources.map(s=>s.feedback),
    node_review_rounds:sources.map(s=>s.round).filter(Boolean),node_review_votes:sources.flatMap(s=>s.votes),operations_field_snapshots:[]}
  const trace=[]
  let probe,clockMs=Date.parse('2026-09-24T04:00:00.000Z')
  const clock=()=>new Date(clockMs)
  const h=createReadonlyDatabase({source:arraySource(seed),beforeRead:async op=>{trace.push({...op});await beforeRead(op,probe)}})
  const real=createCloudOperationsRepository({db:h.db})
  const base={
    async collectReportBase(input) {
      await hook({stage:'collect',probe})
      return realBase?real.collectReportBase(input):{items:structuredClone(baseRows),manifest:{lines:[],nodes:[]}}
    },
    async validateReportBase(input) {
      await hook({stage:'validate',probe})
      if(realBase) await real.validateReportBase(input)
    }
  }
  const freshRepository=()=>createCloudOperationsFieldRepository({db:h.db,operationsRepository:base,secret:PROBE_SECRET,clock})
  probe={actor,sources,trace,metrics:h.metrics,replace:h.replaceForTest,operationsRepository:real,
    freshRepository,repository:freshRepository(),advanceClock(ms){clockMs+=ms},
    codec:createOperationsReportCursor({secret:PROBE_SECRET,clock}),
    range(version=1,pageSize=2) {
      assert.ok([1,2].includes(version))
      return normalizeFieldReportQuery({startDate:'2026-09-01',endDate:'2026-09-23',pageSize,
        ...(version===2?{reportVersion:2,analysis:{view:'catalog'}}:{})},clock())
    }}
  return probe
}

const canonical=value=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(canonical):
  value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function captureContract(p,version=1) {
  const range=p.range(version,2)
  const measure=async(repository,query)=>{
    const start=p.metrics(),page=await repository.exportReportRows({actor:p.actor,range:query}),end=p.metrics()
    return {page,reads:end.reads-start.reads,transactions:end.transactions-start.transactions}
  }
  const first=await measure(p.repository,range)
  assert.equal(first.page.hasMore,true,'contract fixture must span pages')
  const query={...range};delete query.cursor;delete query.pageSize
  const firstCursorBody=p.codec.decode(first.page.nextCursor,{actorId:p.actor._id,queryDigest:hash(canonical(query))})
  const continuation={...range,cursor:first.page.nextCursor}
  const warm=await measure(p.repository,continuation),cold=await measure(p.freshRepository(),continuation)
  assert.deepEqual(warm.page.items,cold.page.items)
  assert.equal(warm.page.hasMore,cold.page.hasMore)
  const rows=[...first.page.items,...warm.page.items],seen=new Set([first.page.nextCursor])
  let page=warm.page
  for(;;) {
    assert.equal(page.hasMore,Boolean(page.nextCursor))
    assert.ok(rows.length<=50000)
    if(!page.hasMore) break
    assert.ok(page.items.length>0&&!seen.has(page.nextCursor))
    seen.add(page.nextCursor)
    page=await p.repository.exportReportRows({actor:p.actor,range:{...range,cursor:page.nextCursor}})
    rows.push(...page.items)
  }
  assert.equal(p.metrics().writeAttempts,0)
  return {rowsDigest:hash(rows),rowCount:rows.length,firstCursorBody,
    firstPageReads:first.reads,warmPageReads:warm.reads,coldPageReads:cold.reads,
    firstPageTransactions:first.transactions,warmPageTransactions:warm.transactions,
    coldPageTransactions:cold.transactions,maxTransactionOperations:p.metrics().maxTransactionOperations}
}
module.exports={reportSources,createReportProbe,captureContract}
