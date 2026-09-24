const test=require('node:test'),assert=require('node:assert/strict')
const {analysisRecords,productRecords,selection}=require('../../cloudfunctions/businessApi/test/helpers/field-analysis-fixtures')
const {buildFieldAnalysis}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis')
let formatAnalysisPage,reduceAnalysisSelection
try {({formatAnalysisPage,reduceAnalysisSelection}=require('../utils/operations-field-analysis'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
function page(rows,input) {const {matchedNodeIds,...r}=buildFieldAnalysis(rows,input);return {...r,schemaVersion:1,scope:'authorized',incomplete:false,totalCount:r.items.length,hasMore:false,nextCursor:''}}
test('changing upstream product value drops downstream conditions without modifying prior selection',()=>{
  assert.equal(typeof reduceAnalysisSelection,'function')
  const prior={view:'product',nodeGroupId:'n',linkageId:'l',dimensionIds:[],filters:[{dimensionId:'category',value:'椅类'},{dimensionId:'brand',value:'品牌甲'},{dimensionId:'model',value:'型号一'}]}
  const next=reduceAnalysisSelection(prior,{type:'productValue',index:0,dimensionId:'category',value:'桌类'})
  assert.deepEqual(next.filters,[{dimensionId:'category',value:'桌类'}]);assert.equal(prior.filters.length,3)
})
test('formatter projects verified select data, whole-sample percentages and no private extras',()=>{
  assert.equal(typeof formatAnalysisPage,'function')
  const rows=analysisRecords(),raw=page(rows,selection(rows,'pair',['choice','tags']))
  raw.privateText='secret';raw.items[0].rawSource='secret'
  const result=formatAnalysisPage(raw)
  assert.equal(result.items[0].percent,'100%');assert.equal(result.items[1].percent,'50%')
  assert.ok(result.explanation.includes('100%'));assert.ok(!JSON.stringify(result).includes('secret'))
})
test('formatter rejects malformed count, denominator, dimension binding and duplicate tuples',()=>{
  assert.equal(typeof formatAnalysisPage,'function')
  const rows=analysisRecords(),base=page(rows,selection(rows,'pair',['choice','tags']))
  for(const mutate of [r=>r.view='unknown',r=>r.items[0].count=-1,r=>r.items[0].count=3,
    r=>r.filledSampleCount=0,r=>r.items[0].values=['A'],r=>r.items.push({...r.items[0]}),
    r=>r.dimensionMetadata[0].id='x',r=>r.dimensionMetadata[1].id=r.dimensionMetadata[0].id]) {
    const raw=structuredClone(base);mutate(raw);assert.throws(()=>formatAnalysisPage(raw))
  }
})
test('node previews and product attribute holes retain metadata identity',()=>{
  assert.equal(typeof formatAnalysisPage,'function')
  const rows=productRecords(),link=rows[0].schema.linkages[0]
  const input=selection(rows,'product',[],{linkageId:link.id,filters:link.dimensionIds.slice(0,3).map((dimensionId,i)=>({dimensionId,value:['椅类','品牌甲','型号一'][i]}))})
  const out=formatAnalysisPage(page(rows,input))
  assert.deepEqual(out.items.map(i=>i.fieldKey),['color','headrest'])
  assert.ok(out.items.every(i=>i.options.length===1 && i.options[0].percent==='100%'))
})
module.exports={page}
