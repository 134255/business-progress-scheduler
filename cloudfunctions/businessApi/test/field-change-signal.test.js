'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {createFakeCloudDatabase}=require('./helpers/fake-cloud-database')
const {createCloudFieldRefreshQueue}=require('../lib/cloud-field-refresh-queue')
const file=path.join(__dirname,'../lib/operations-field-change-signal.js')
const createSignal=fs.existsSync(file)?require(file).createOperationsFieldChangeSignal:undefined
const ACTIONS=['submitFeedback','saveAndSubmitNodeForReview','submitNodeForReview','submitReviewVote',
  'decideNodeRoute','decideOptionalTailNode','rejectPreviousNode','updateBusinessMetadata','closeBusinessLine','amendFrozenBusiness']
function harness(enabled=true) {
  assert.equal(typeof createSignal,'function','post-success private queue signal is missing')
  const actor={_id:'staff',status:'active',role:'user'}
  const fake=createFakeCloudDatabase({users:[actor],business_lines:[{_id:'line-1',managerUserIds:['root'],memberUserIds:['staff']}],
    business_nodes:[{_id:'node-1',businessLineId:'line-1'}],node_review_rounds:[{_id:'round-1',nodeId:'node-1',businessLineId:'line-1'}]})
  return {fake,actor,signal:createSignal({db:fake.db,queue:createCloudFieldRefreshQueue({db:fake.db}),enabled})}
}
for(const action of ACTIONS)test(`successful ${action} registers the actual owning line`,async()=>{
  const h=harness()
  const result=await h.signal.enqueueAfterMutation({actor:h.actor,action,
    payload:{nodeId:'node-1',currentNodeId:'node-1',reviewRoundId:'round-1',businessLineId:'line-1'},result:{id:'line-1',businessLineId:'line-1'}})
  assert.equal(result,'queued');assert.equal(h.fake.documents('operations_field_refresh_queue')[0].businessLineId,'line-1')
  assert.ok(h.fake.writeCalls.every(x=>x.collection==='operations_field_refresh_queue'))
})
test('disabled or unrelated actions cannot even read mutation or account records',async()=>{
  for(const [enabled,action] of [[false,'submitFeedback'],[true,'createBusinessFromTemplate'],[true,'getSession']]) {
    const h=harness(enabled)
    assert.ok(['disabled','ignored'].includes(await h.signal.enqueueAfterMutation({actor:h.actor,action,payload:{}})))
    assert.equal(h.fake.readCalls.length,0);assert.equal(h.fake.writeCalls.length,0)
  }
})
test('vote routing cannot be redirected by an unrelated client businessLineId',async()=>{
  const h=harness();await h.signal.enqueueAfterMutation({actor:h.actor,action:'submitReviewVote',payload:{reviewRoundId:'round-1',businessLineId:'unrelated'}})
  assert.equal(h.fake.documents('operations_field_refresh_queue')[0].businessLineId,'line-1')
})
test('a node input/result ownership mismatch cannot enqueue a different line',async()=>{
  const h=harness()
  await assert.rejects(h.signal.enqueueAfterMutation({actor:h.actor,action:'submitFeedback',payload:{nodeId:'node-1',businessLineId:'other'},result:{businessLineId:'other'}}))
  assert.equal(h.fake.documents('operations_field_refresh_queue').length,0)
})
test('post-commit account disablement refuses a new private hint without touching business',async()=>{
  const h=harness();h.fake.replace('users','staff',{...h.actor,status:'disabled'})
  await assert.rejects(h.signal.enqueueAfterMutation({actor:h.actor,action:'closeBusinessLine',payload:{businessLineId:'line-1'}}))
  assert.equal(h.fake.writeCalls.length,0)
})
module.exports={ACTIONS}
