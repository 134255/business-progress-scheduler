'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {createFakeCloudDatabase}=require('./helpers/fake-cloud-database')
const {createCloudFieldRefreshQueue}=require('../lib/cloud-field-refresh-queue')
const fs=require('node:fs'),path=require('node:path')
const file=path.join(__dirname,'../lib/operations-field-change-signal.js')
const createSignal=fs.existsSync(file)?require(file).createOperationsFieldChangeSignal:undefined
const old=Module._load
Module._load=function(request,parent,main){if(request==='wx-server-sdk')return {init(){},database:()=>({command:{}})};return old.call(this,request,parent,main)}
const {createBusinessApi}=require('../index');Module._load=old
const ACTIONS=['submitFeedback','saveAndSubmitNodeForReview','submitNodeForReview','submitReviewVote','decideNodeRoute',
  'decideOptionalTailNode','rejectPreviousNode','updateBusinessMetadata','closeBusinessLine','amendFrozenBusiness']
const FIELDS=new Set(['submitFeedback','saveAndSubmitNodeForReview','submitNodeForReview','submitReviewVote','decideNodeRoute'])
function harness(action,{businessFails=false,signalFails=false,refreshFails=false}={}) {
  const actor={_id:'staff',status:'active',role:'user'}
  const fake=createFakeCloudDatabase({users:[actor],business_lines:[{_id:'line-1',managerUserIds:['root'],memberUserIds:['staff']}],
    business_nodes:[{_id:'node-1',businessLineId:'line-1'}],node_review_rounds:[{_id:'round-1',nodeId:'node-1',businessLineId:'line-1'}]})
  const signal=createSignal?createSignal({db:fake.db,queue:createCloudFieldRefreshQueue({db:fake.db}),enabled:true}):{async enqueueAfterMutation(){throw Error('not implemented')}}
  const result={businessLineId:'line-1',id:'line-1',version:2}
  const api=createBusinessApi({repository:{async findUserByOpenid(){return actor},async findCredential(){return {mustChangePassword:false,lockedUntil:null}}},
    getContext:()=>({OPENID:'synthetic'}),logger:{error(){}},
    protectedRoutes:{async [action](){if(businessFails)throw Error('original failure');return result}},
    operationsFieldService:{async refreshAfterMutation(){fake.replace('refresh_test','completed',{_id:'completed',beforeQueue:fake.documents('operations_field_refresh_queue').length});if(refreshFails)throw Error('derived failure')}},
    fieldChangeSignal:signalFails?{async enqueueAfterMutation(){throw Error('queue failure')}}:signal})
  return {fake,result,run:()=>api.main({action,payload:{nodeId:'node-1',currentNodeId:'node-1',reviewRoundId:'round-1',businessLineId:'line-1'}})}
}
for(const action of ACTIONS)test(`API ${action} retains its response and registers a private recovery hint`,async()=>{
  const h=harness(action);assert.deepEqual(await h.run(),{ok:true,data:h.result})
  assert.equal(h.fake.documents('operations_field_refresh_queue').length,1)
  if(FIELDS.has(action))assert.equal(h.fake.documents('refresh_test')[0].beforeQueue,1)
})
test('queue failure cannot prevent existing immediate refresh or original success',async()=>{
  const h=harness('submitFeedback',{signalFails:true});assert.deepEqual(await h.run(),{ok:true,data:h.result})
  assert.equal(h.fake.documents('refresh_test').length,1)
})
test('immediate refresh failure cannot undo the already durable queue or success',async()=>{
  const h=harness('submitFeedback',{refreshFails:true});assert.deepEqual(await h.run(),{ok:true,data:h.result})
  assert.equal(h.fake.documents('operations_field_refresh_queue').length,1)
})
test('business failure causes neither queue registration nor immediate refresh',async()=>{
  const h=harness('submitFeedback',{businessFails:true});assert.equal((await h.run()).ok,false)
  assert.equal(h.fake.documents('operations_field_refresh_queue').length,0);assert.equal(h.fake.documents('refresh_test').length,0)
})
