'use strict'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),assert=require('node:assert/strict')
const {createOperationMeter,createCapacityDatabase}=require('./lib/analytics-field-recovery-meter.cjs')
const {fixture}=require('../../cloudfunctions/operationsAnalytics/test/helpers/field-priority-fixture')
const ROOT=path.resolve(__dirname,'../..')
const load=(root,file)=>require(path.join(root,file))
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const compareRows=rows=>rows.slice().sort((a,b)=>a._id.localeCompare(b._id))
function apiFactory(root,db){
  const old=Module._load
  try {
    Module._load=function(request,parent,main){if(request==='wx-server-sdk')return {init(){},database:()=>db};return old.call(this,request,parent,main)}
    return load(root,'cloudfunctions/businessApi/index.js').createBusinessApi
  } finally {Module._load=old}
}
async function runSide(root,scenario,intervalMinutes,cycles,priority,databaseFactory) {
  const prepared=fixture(scenario.count,{reviewed:scenario.reviewed===true,dbFactory:createCapacityDatabase})
  // fixture's service constructors need a real DB; keep setup separate from all
  // metered calls. The adapter never initializes a cloud SDK or uses network.
  const seed=structuredClone(prepared.seed)
  if(scenario.unfinished)for(const node of seed.business_nodes){node.status='in_progress';node.routeState='active'}
  const domain=load(root,'cloudfunctions/operationsAnalytics/lib/operations-field-domain.js')
  if(!scenario.unfinished)seed.operations_field_snapshots=prepared.sources.map(source=>({_id:source.node._id,...domain.selectionSnapshot(domain.buildFinalFieldResult(source))}))
  seed.users=[{_id:'processor-1',role:'user',status:'active'}]
  seed.user_credentials=[{_id:'processor-1',mustChangePassword:false,lockedUntil:null}]
  seed.operations_analytics_facts=[];seed.operations_analytics_daily=[]
  const fake=databaseFactory?databaseFactory(seed,{}):createCapacityDatabase(seed,{},path.join(root,'cloudfunctions/businessApi/test/helpers/fake-cloud-database.js'))
  const meter=createOperationMeter(fake.db)
  let stamp=Date.parse('2026-11-09T03:00:00Z'),sequence=0
  const clock=()=>new Date(stamp),tokens=()=> (++sequence).toString(16).padStart(32,'0')
  const {createFieldSnapshotRecovery}=load(root,'cloudfunctions/operationsAnalytics/lib/field-snapshot-recovery.js')
  const core=createFieldSnapshotRecovery({db:meter.db,clock})
  const queue=priority?load(root,'cloudfunctions/operationsAnalytics/lib/cloud-field-refresh-queue.js').createCloudFieldRefreshQueue({db:meter.db,clock,tokenFactory:tokens}):null
  const fields=priority?load(root,'cloudfunctions/operationsAnalytics/lib/field-change-priority-recovery.js').createFieldChangePriorityRecovery({db:meter.db,queue,sourceRecovery:core,clock,tokenFactory:tokens}):core
  const analytics=load(root,'cloudfunctions/operationsAnalytics/lib/analytics-service.js').createAnalyticsService({
    analyticsRepository:load(root,'cloudfunctions/operationsAnalytics/lib/cloud-analytics-repository.js').createCloudAnalyticsRepository({db:meter.db})})
  const handler=load(root,'cloudfunctions/operationsAnalytics/index.js').createOperationsAnalyticsHandler({
    service:{runCycle:input=>meter.inPhase('facts',()=>analytics.runCycle(input))},
    fieldRecovery:{runCycle:input=>meter.inPhase('field',()=>fields.runCycle(input))},clock,getTriggerSource:()=> 'timer',logger:{error(){throw Error('Unexpected handler failure')}}})
  const fieldRepository=load(root,'cloudfunctions/businessApi/lib/cloud-operations-field-repository.js').createCloudOperationsFieldRepository({db:meter.db,clock})
  const signal=priority?load(root,'cloudfunctions/businessApi/lib/operations-field-change-signal.js').createOperationsFieldChangeSignal({db:meter.db,queue,enabled:true}):undefined
  const createApi=apiFactory(root,meter.db)
  const api=createApi({repository:{async findUserByOpenid(){return (await meter.db.collection('users').doc('processor-1').get()).data},async findCredential(){return (await meter.db.collection('user_credentials').doc('processor-1').get()).data}},
    getContext:()=>({OPENID:'synthetic-capacity-only'}),logger:{error(){throw Error('Unexpected API failure')}},
    protectedRoutes:{async submitFeedback({payload}){return {businessLineId:payload.businessLineId,nodeId:payload.nodeId}}},
    operationsFieldService:{refreshAfterMutation:input=>fieldRepository.refreshAfterMutation(input)},fieldChangeSignal:signal})
  const protectedNames=['business_lines','business_nodes','node_feedback','node_review_rounds','node_review_votes','notifications','users','user_credentials']
  const originalProtected=new Map(protectedNames.map(name=>[name,hash(fake.documents(name))]))
  const expectations=new Map(),lags=[],trace=[]
  let firstCycle=null,mutationCount=0
  for(let cycle=0;cycle<cycles;cycle++) {
    stamp=Date.parse('2026-11-09T03:00:00Z')+cycle*intervalMinutes*60000
    const pattern=scenario.pattern||'idle'
    let changes=0
    if(cycle===1&&['single','burst','missed','enqueue-failed'].includes(pattern))changes=pattern==='burst'?Math.min(30,scenario.count):Math.min(1,scenario.count)
    if(cycle>0&&pattern==='continuous')changes=Math.min(1,scenario.count)
    for(let i=0;i<changes;i++) {
      const source=prepared.sources[(cycle+i)%Math.max(1,scenario.count)],nodeId=source.node._id
      await meter.inPhase('syntheticMutation',async()=>{
        const fb=(await meter.db.collection('node_feedback').doc(source.feedback._id).get()).data
        const item=fb.fieldValues.find(v=>v.fieldKey==='choice');item.value=item.value==='A'?'B':'A'
        await meter.db.collection('node_feedback').doc(fb._id).update({data:{fieldValues:fb.fieldValues}})
        if(source.round)await meter.db.collection('node_review_rounds').doc(source.round._id).update({data:{fieldValues:fb.fieldValues}})
        expectations.set(nodeId,{choice:item.value,cycle})
      })
      mutationCount++
      if(pattern!=='missed') {
        if(priority&&pattern==='enqueue-failed')fake.failNextWrite({collection:'operations_field_refresh_queue',operation:'set',error:new Error('Synthetic enqueue write failure')})
        const result=await meter.inPhase('apiPostSuccess',()=>api.main({action:'submitFeedback',payload:{nodeId,businessLineId:source.node.businessLineId}}))
        assert.equal(result.ok,true)
      }
    }
    const result=await handler();assert.equal(result.failed,0);assert.equal(result.fieldFailed,0)
    const current=fake.state.operations_field_snapshots||new Map()
    for(const [nodeId,expected] of expectations) {
      const snapshot=current.get(nodeId)
      if(snapshot&&snapshot.fields.some(f=>f.fieldKey==='choice'&&f.value===expected.choice)) {lags.push((cycle-expected.cycle)*intervalMinutes);expectations.delete(nodeId)}
    }
    const report=meter.report();if(cycle===0)firstCycle=report
    if(cycle<100||cycle===cycles-1)trace.push({cycle:cycle+1,...report.totals})
  }
  const report=meter.report()
  const allowed=new Set(['system_settings','operations_field_snapshots','operations_field_refresh_queue','node_feedback','node_review_rounds'])
  assert.ok(fake.writeCalls.every(row=>allowed.has(row.collection)))
  for(const name of protectedNames.filter(x=>!['node_feedback','node_review_rounds'].includes(x)))assert.equal(hash(fake.documents(name)),originalProtected.get(name))
  return {...report,firstCycle,trace,mutationCount,maxObservedRepairLagMinutes:lags.length?Math.max(...lags):0,unresolvedTargets:expectations.size,
    snapshotsHash:hash(compareRows(fake.documents('operations_field_snapshots'))),
    protectedHash:hash(protectedNames.map(name=>[name,compareRows(fake.documents(name))])),
    localCommittedWrites:fake.writeCalls.length,maxTransactionOperations:Math.max(0,...fake.transactionRuns.map(x=>x.operations))}
}
async function runComparison({baselineRoot,candidateRoot=ROOT,scenario={count:30},intervalMinutes=15,cycles=100,databaseFactory}={}) {
  assert.ok(baselineRoot);assert.ok(Number.isSafeInteger(cycles)&&cycles>0);assert.ok([1,5,15].includes(intervalMinutes))
  const baseline=await runSide(path.resolve(baselineRoot),scenario,intervalMinutes,cycles,false,databaseFactory)
  const candidate=await runSide(path.resolve(candidateRoot),scenario,intervalMinutes,cycles,true,databaseFactory)
  const protectedStateEqual=baseline.protectedHash===candidate.protectedHash,snapshotsEqual=baseline.snapshotsHash===candidate.snapshotsHash
  assert.equal(protectedStateEqual,true)
  if((scenario.pattern||'idle')!=='missed')assert.equal(snapshotsEqual,true)
  assert.deepEqual(baseline.byPhase.facts,candidate.byPhase.facts)
  assert.ok(candidate.maxTransactionOperations<=100)
  return {scenario,intervalMinutes,cycles,baseline,candidate,protectedStateEqual,snapshotsEqual,
    cloudRequests:0,cashSavingsVerified:false,
    limits:'Synthetic in-memory SDK and real worker handlers/API post-success hooks. Source perturbations simulate an already committed mutation, not permission to edit finalized feedback. Original business mutation implementation, cloud SDK latency, billed units and cash savings are not inferred from these results.'}
}
module.exports={runComparison}
if(require.main===module) {
  const [baselineRoot,output,profile='full']=process.argv.slice(2)
  ;(async()=>{
    const results=[]
    const scenarios=[{count:0},{count:30},{count:30,reviewed:true},{count:150},{count:2000},{count:30,unfinished:true}]
    for(const scenario of scenarios)for(const intervalMinutes of [1,5,15]) {
      const cycles=profile==='quick'?100:1440/intervalMinutes
      const report=await runComparison({baselineRoot,scenario,intervalMinutes,cycles})
      results.push(report)
      console.log(JSON.stringify({scenario,intervalMinutes,cycles,old:report.baseline.totals,new:report.candidate.totals}))
      if(output)fs.writeFileSync(output,JSON.stringify({complete:false,results},null,2)+'\n')
    }
    for(const pattern of ['single','burst','continuous','missed']) {
      const report=await runComparison({baselineRoot,scenario:{count:30,reviewed:true,pattern},intervalMinutes:5,cycles:288})
      results.push(report);console.log(JSON.stringify({pattern,old:report.baseline.totals,new:report.candidate.totals}))
    }
    if(output)fs.writeFileSync(output,JSON.stringify({complete:true,results},null,2)+'\n')
  })().catch(error=>{console.error(error);process.exitCode=1})
}
