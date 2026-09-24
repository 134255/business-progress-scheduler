'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const business=require('../../../miniprogram/services/business')
const {recordPerformanceTiming}=require('../../../miniprogram/utils/performance-timing')
const actions=['getOperationsDashboard','exportOperationsRows','getOperationsAnalyticsFilters','getOperationsAnalyticsSummary',
  'getOperationsFieldSummary','getOperationsFieldFilters','getOperationsFieldAnalysis','exportOperationsReportRows']
function restoreGlobals(t) {
  const wx=global.wx,getApp=global.getApp
  t.after(()=>{global.wx=wx;global.getApp=getApp})
}
for(const action of actions) test(`opt-in ${action} preserves success, failure, request count and toast behavior`,async t=>{
  restoreGlobals(t)
  for(const failure of [false,true]) {
    let baseline
    for(const mode of [undefined,false,true,'getAppThrows','stateThrows']) {
      const app={globalData:{performanceDiagnostics:mode}},requests=[],toasts=[],data={private:'synthetic-response'}
      global.getApp=()=>{if(mode==='getAppThrows') throw Error('diagnostic failure');return app}
      if(mode==='stateThrows') Object.defineProperty(app,'globalData',{get(){throw Error('diagnostic state')}})
      global.wx={showToast:v=>toasts.push(v),cloud:{async callFunction(request){requests.push(request)
        return {result:failure?{ok:false,code:'FORBIDDEN',message:'synthetic-private-error'}:{ok:true,data}}}}}
      let returned,error
      try {returned=await business[action]({private:'synthetic-input'})} catch(e) {error={code:e.code,message:e.message}}
      if(!failure) assert.equal(returned,data)
      else assert.equal(error.code,'FORBIDDEN')
      assert.equal(requests.length,1);assert.equal(requests[0].data.action,action)
      const observed={returned,error,requests,toasts}
      if(baseline) assert.deepEqual(observed,baseline);else baseline=observed
      if(mode===true) {
        const samples=app.globalData.performanceTimings
        assert.equal(samples?.length,1)
        assert.deepEqual(Object.keys(samples[0]).sort(),['action','durationMs','outcomeCode'])
        assert.equal(samples[0].action,action);assert.equal(samples[0].outcomeCode,failure?'ERROR':'OK')
        assert.doesNotMatch(JSON.stringify(samples),/private|synthetic/)
      } else if(mode===false||mode===undefined) assert.equal(app.globalData.performanceTimings,undefined)
    }
  }
})
test('new actions retain memory cap, disabled cleanup and invalid event rejection',async t=>{
  restoreGlobals(t)
  const state={performanceDiagnostics:true};global.getApp=()=>({globalData:state})
  global.wx={cloud:{async callFunction(){return {result:{ok:true,data:{}}}}}}
  for(let i=0;i<105;i++) await business.getOperationsFieldAnalysis({})
  assert.equal(state.performanceTimings?.length,100)
  const before=JSON.stringify(state.performanceTimings)
  for(const event of [{action:'unknown',durationMs:1},{action:actions[0],durationMs:NaN},{action:actions[0],durationMs:Infinity},
    {action:actions[0],durationMs:1,stage:'private'}]) recordPerformanceTiming(event)
  assert.equal(JSON.stringify(state.performanceTimings),before)
  state.performanceDiagnostics=false
  await business.getOperationsFieldAnalysis({});assert.equal(state.performanceTimings,undefined)
})
