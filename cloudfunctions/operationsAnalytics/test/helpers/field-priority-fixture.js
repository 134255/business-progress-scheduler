'use strict'
const {createFakeCloudDatabase}=require('../../../businessApi/test/helpers/fake-cloud-database')
const {fieldSource}=require('../../../businessApi/test/helpers/field-fixtures')
const {createCloudFieldRefreshQueue}=require('../../lib/cloud-field-refresh-queue')
const {createFieldSnapshotRecovery}=require('../../lib/field-snapshot-recovery')
function fixture(count=3,{reviewed=false,options={},dbFactory=createFakeCloudDatabase}={}) {
  const sources=Array.from({length:count},(_,i)=>fieldSource({nodeId:`node-${String(i+1).padStart(5,'0')}`,reviewed,
    line:{_id:`line-${String(Math.floor(i/100)).padStart(3,'0')}`,analyticsSnapshotStatus:'generated'},
    node:{nodeCode:`SYN-${i}`,analyticsSnapshotStatus:'generated'}}))
  const lines=[...new Set(sources.map(s=>s.line._id))].map(lineId=>{
    const members=sources.filter(s=>s.line._id===lineId)
    return {...members[0].line,code:`SYN-${lineId}`,nodeCount:members.length,traversedNodeIds:members.map(s=>s.node._id)}
  })
  for(const source of sources)source.line=lines.find(line=>line._id===source.node.businessLineId)
  const seed={business_lines:lines,business_nodes:sources.map(s=>s.node),node_feedback:sources.map(s=>s.feedback),
    node_review_rounds:sources.map(s=>s.round).filter(Boolean),node_review_votes:sources.flatMap(s=>s.votes),
    operations_field_snapshots:[],system_settings:[],notifications:[{_id:'existing-note',status:'pending'}]}
  const fake=dbFactory(seed,{rejectExplicitIdOnSet:true,...options})
  let stamp=Date.parse('2026-11-09T03:00:00Z'),sequence=0
  const clock=()=>new Date(stamp),tokenFactory=()=> (++sequence).toString(16).padStart(32,'0')
  const queue=createCloudFieldRefreshQueue({db:fake.db,clock,tokenFactory})
  const sourceRecovery=createFieldSnapshotRecovery({db:fake.db,clock})
  const protectedState=()=>['business_lines','business_nodes','node_feedback','node_review_rounds','node_review_votes','notifications'].map(name=>fake.documents(name))
  return {fake,seed,sources,clock,tokenFactory,queue,sourceRecovery,protectedState,
    advance:ms=>{stamp+=ms},setTime:ms=>{stamp=ms}}
}
module.exports={fixture}
