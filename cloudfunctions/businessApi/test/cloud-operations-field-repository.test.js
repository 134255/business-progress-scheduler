const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { normalizeFieldQuery } = require('../lib/operations-field-service')
let createCloudOperationsFieldRepository
try { ({ createCloudOperationsFieldRepository } = require('../lib/cloud-operations-field-repository')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
const now = new Date('2026-09-11T03:00:00Z')
const admin = { _id: 'root', role: 'super_admin', status: 'active' }
const staff = { _id: 'staff', role: 'user', status: 'active' }
function harness(options = {}) {
  assert.equal(typeof createCloudOperationsFieldRepository, 'function', 'field repository must query authorized sources before aggregating')
  const { fieldSource } = require('./helpers/field-fixtures')
  const sources = [fieldSource({ nodeId: 'node-1' }), fieldSource({ nodeId: 'node-2' })]
  for (const [index, source] of sources.entries()) {
    source.line._id = `line-${index+1}`
    source.line.code = `BL-${index+1}`
    source.line.managerUserIds = ['root']
    source.line.memberUserIds = index ? ['root'] : ['staff']
    source.node.businessLineId = source.line._id
    source.node.nodeCode = `BL-${index+1}-N001`
    source.node.completedAt = new Date('2026-09-10T03:00:00Z')
    source.feedback.businessLineId = source.line._id
    if(source.round) source.round.businessLineId = source.line._id
    for(const vote of source.votes || []) vote.businessLineId = source.line._id
  }
  const fake = createFakeCloudDatabase({
    users: [admin,staff],
    business_lines:sources.map(s=>s.line), business_nodes:sources.map(s=>s.node),
    node_feedback:sources.map(s=>s.feedback),node_review_rounds:sources.map(s=>s.round).filter(Boolean),
    node_review_votes:sources.flatMap(s=>s.votes||[]),operations_field_snapshots:[],templates:[]
  },options)
  let baseReads=0
  const repository = createCloudOperationsFieldRepository({ db:fake.db,secret:'synthetic-test-report-key'.repeat(3),clock:()=>now,
    operationsRepository:{async collectReportBase(input){ baseReads++; if(options.onBaseRead) options.onBaseRead({fake,sources,input}); return {items:[{businessCode:'BL-BASE',nodeCode:'BL-BASE-N001',processingElapsedWorkMinutes:7}],manifest:{lines:[],nodes:[]}} },
      async validateReportBase(){} } })
  const range = normalizeFieldQuery({startDate:'2026-09-01',endDate:'2026-09-11'},now)
  return {fake,repository,range,sources,baseReads:()=>baseReads}
}
test('field repository counts only currently authorized completed nodes; administrator can count all', async()=>{
  const {repository,range}=harness()
  const own=await repository.getSummary({actor:staff,range})
  const all=await repository.getSummary({actor:admin,range})
  assert.equal(own.scope,'authorized');assert.equal(own.sampledNodeCount,1)
  assert.equal(all.scope,'all');assert.equal(all.sampledNodeCount,2)
  assert.ok(own.groups.length>0)
  assert.equal(JSON.stringify(own).includes('BL-2'),false)
})
test('field report denies ordinary users and reads actor role from the current database',async()=>{
  const {repository,range,fake}=harness()
  await assert.rejects(repository.exportReportRows({actor:staff,range}),{code:'FORBIDDEN'})
  fake.replace('users','root',{...admin,role:'user'})
  await assert.rejects(repository.exportReportRows({actor:admin,range}),{code:'FORBIDDEN'})
})
test('field report includes typed detail and counted summary, preserves original operational rows',async()=>{
  const {repository,range}=harness()
  const all=await repository.exportReportRows({actor:admin,range})
  assert.equal(all.items[0].businessCode,'BL-BASE')
  assert.equal(all.items[0].recordType,'运营基础')
  assert.ok(all.items.some(x=>x.recordType==='字段明细'))
  assert.ok(all.items.some(x=>x.recordType==='选项统计'))
  assert.ok(all.items.filter(x=>x.recordType!=='运营基础').every(x=>x.processingElapsedWorkMinutes===undefined))
})
test('field report rejects source changes between pages and another account continuation',async()=>{
  const {repository,range,fake,sources}=harness()
  const first=await repository.exportReportRows({actor:admin,range:{...range,pageSize:1}})
  assert.equal(first.hasMore,true)
  assert.equal(first.nextCursor.includes('root'),false)
  fake.replace('business_lines',sources[0].line._id,{...sources[0].line,name:'renamed after page'})
  await assert.rejects(repository.exportReportRows({actor:admin,range:{...range,pageSize:1,cursor:first.nextCursor}}),{code:'REPORT_CHANGED'})
})
test('missing authoritative final source marks incomplete statistics and refuses partial export',async()=>{
  const {repository,range,fake,sources}=harness()
  fake.replace('business_nodes',sources[0].node._id,{...sources[0].node,latestFeedbackId:'missing-feedback'})
  const summary=await repository.getSummary({actor:admin,range})
  assert.equal(summary.incomplete,true)
  await assert.rejects(repository.exportReportRows({actor:admin,range}),{code:'INCOMPLETE_FIELD_DATA'})
})
test('explicit inaccessible business filter fails closed rather than exposing its sample count',async()=>{
  const {repository,range}=harness()
  await assert.rejects(repository.getSummary({actor:staff,range:{...range,businessLineId:'line-2'}}),{code:'FORBIDDEN'})
})
test('revocation after candidate reads cannot return formerly accessible field statistics',async()=>{
  const {repository,range,fake}=harness()
  fake.beforeNextTransaction(()=>fake.replace('users','staff',{...staff,status:'disabled'}))
  await assert.rejects(repository.getSummary({actor:staff,range}),{code:'FORBIDDEN'})
})

test('validated selection snapshots avoid rereading final text while stale snapshots fall back to authority',async()=>{
  const reads=[]
  const {repository,range,fake,sources}=harness({transformRead:({collection,data})=>{reads.push(collection);return data}})
  const domain=require('../lib/operations-field-domain')
  for(const source of sources) fake.replace('operations_field_snapshots',source.node._id,
    {_id:source.node._id,...domain.selectionSnapshot(domain.buildFinalFieldResult(source))})
  reads.length=0
  const result=await repository.getSummary({actor:staff,range})
  assert.equal(result.sampledNodeCount,1)
  assert.equal(reads.includes('node_feedback'),false)
  fake.replace('business_nodes','node-1',{...sources[0].node,latestFeedbackRevision:999})
  const stale=await repository.getSummary({actor:staff,range})
  assert.equal(stale.incomplete,true)
  assert.equal(stale.sampledNodeCount,0)
})

test('post-success refresh publishes only selection data and never changes business source records',async()=>{
  const {repository,fake,sources}=harness({rejectExplicitIdOnSet:true})
  const before=JSON.stringify(fake.documents('node_feedback'))
  await repository.refreshAfterMutation({actor:staff,action:'submitFeedback',payload:{nodeId:sources[0].node._id}})
  const snapshot=fake.documents('operations_field_snapshots')[0]
  assert.equal(snapshot.nodeId,'node-1')
  assert.deepEqual(snapshot.fields.map(f=>f.type),['single_select','multi_select'])
  assert.equal(JSON.stringify(fake.documents('node_feedback')),before)
  assert.ok(fake.writeCalls.every(call=>call.collection==='operations_field_snapshots'))
})

test('history filters discover authorized final instance data without templates or timing facts',async()=>{
  const {repository,range}=harness()
  const filters=await repository.getFilters({actor:staff,range:{...range,templateId:'template-1'}})
  assert.equal(filters.templates[0].templateId,'template-1')
  assert.deepEqual(filters.templateVersions,[1])
  assert.equal(filters.stableNodes[0].stableNodeId,'stable-node-1')
  assert.equal(filters.incomplete,false)
})

test('field-only reviewed results supply authorized business and actual participant filter candidates',async()=>{
  const {fieldSource}=require('./helpers/field-fixtures')
  const source=fieldSource({reviewed:true})
  source.line.memberUserIds.push(staff._id)
  const fake=createFakeCloudDatabase({users:[staff,admin],business_lines:[source.line],business_nodes:[source.node],
    node_feedback:[source.feedback],node_review_rounds:[source.round],node_review_votes:source.votes})
  const repository=createCloudOperationsFieldRepository({db:fake.db})
  const range=normalizeFieldQuery({startDate:'2026-09-01',endDate:'2026-09-11',templateId:'template-1'},now)
  const filters=await repository.getFilters({actor:staff,range})
  assert.deepEqual(filters.businesses,[{businessLineId:source.line._id,businessCode:source.line.code,businessName:source.line.name}])
  assert.deepEqual(filters.processors.map(p=>p.displayName),['合成处理人二'])
  assert.deepEqual(filters.reviewers.map(p=>p.displayName),['合成审核人一'])
  assert.ok(filters.processors.every(p=>/^[a-f0-9]{64}$/.test(p.token) && !Object.hasOwn(p,'userId')))
  const selected=await repository.getSummary({actor:staff,range:{...range,businessLineId:filters.businesses[0].businessLineId,
    processorToken:filters.processors[0].token,reviewerToken:filters.reviewers[0].token}})
  assert.equal(selected.sampledNodeCount,1)
  fake.replace('business_lines',source.line._id,{...source.line,memberUserIds:['someone-else']})
  const revoked=await repository.getFilters({actor:staff,range})
  assert.deepEqual(revoked.businesses,[]);assert.deepEqual(revoked.processors,[]);assert.deepEqual(revoked.reviewers,[])
})

test('unwalked route nodes with no final date are excluded, not reported as a historical gap',async()=>{
  const {repository,range,fake,sources}=harness()
  fake.replace('business_lines','line-1',{...sources[0].line,traversedNodeIds:[],currentNodeId:'next-node'})
  fake.replace('business_nodes','node-1',{...sources[0].node,completedAt:null})
  const result=await repository.getSummary({actor:staff,range})
  assert.equal(result.sampledNodeCount,0)
  assert.equal(result.incomplete,false)
})

test('report continuation rejects a changed final feedback identity even when exported values are identical',async()=>{
  const {repository,range,fake,sources}=harness()
  const first=await repository.exportReportRows({actor:admin,range:{...range,pageSize:1}})
  const source=sources[0]
  fake.replace('node_feedback','new-final',{...source.feedback,_id:'new-final',revision:3})
  fake.replace('business_nodes','node-1',{...source.node,latestFeedbackId:'new-final',latestFeedbackRevision:3})
  await assert.rejects(repository.exportReportRows({actor:admin,range:{...range,pageSize:1,cursor:first.nextCursor}}),{code:'REPORT_CHANGED'})
})

test('report source changes during base export are rejected before returning rows',async()=>{
  const {repository,range}=harness({onBaseRead({fake,sources}) {
    const feedback=sources[0].feedback
    fake.replace('node_feedback',feedback._id,{...feedback,fieldValues:feedback.fieldValues.map(f=>f.fieldKey==='choice'?{...f,value:'B'}:f)})
  }})
  await assert.rejects(repository.exportReportRows({actor:admin,range}),{code:'REPORT_CHANGED'})
})

test('warm report continuation revalidates sources without rebuilding the base dataset',async()=>{
  const h=harness()
  const first=await h.repository.exportReportRows({actor:admin,range:{...h.range,pageSize:1}})
  await h.repository.exportReportRows({actor:admin,range:{...h.range,pageSize:1,cursor:first.nextCursor}})
  assert.equal(h.baseReads(),1)
})

test('real base adapter uses batched node queries and cached continuation rejects changed base metadata',async()=>{
  const {createCloudOperationsRepository}=require('../lib/cloud-operations-repository')
  const {fieldSource}=require('./helpers/field-fixtures')
  const sources=Array.from({length:51},(_,i)=>{
    const source=fieldSource({nodeId:`node-${i}`})
    source.line._id=`line-${i}`;source.line.code=`BL-${i}`
    source.node.businessLineId=source.line._id;source.feedback.businessLineId=source.line._id
    return source
  })
  const fake=createFakeCloudDatabase({users:[admin],business_lines:sources.map(s=>s.line),
    business_nodes:sources.map(s=>s.node),node_feedback:sources.map(s=>s.feedback)})
  const repository=createCloudOperationsFieldRepository({db:fake.db,
    operationsRepository:createCloudOperationsRepository({db:fake.db}),secret:'synthetic-key'.repeat(4),clock:()=>now})
  const range=normalizeFieldQuery({startDate:'2026-09-01',endDate:'2026-09-11'},now)
  const first=await repository.exportReportRows({actor:admin,range})
  const scans=fake.queryCalls.filter(q=>q.collection==='business_nodes')
  assert.ok(scans.length<=10,`node scans ${scans.length}`)
  assert.equal(first.items.length,50);assert.equal(first.hasMore,true)
  assert.ok(first.items.every(row=>row.recordType==='运营基础'))
  const source=sources[0]
  fake.replace('business_nodes',source.node._id,{...source.node,processingElapsedWorkMinutes:999})
  await assert.rejects(repository.exportReportRows({actor:admin,range:{...range,cursor:first.nextCursor}}),{code:'REPORT_CHANGED'})
})
