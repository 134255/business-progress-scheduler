const test=require('node:test'),assert=require('node:assert/strict')
let normalizeAnalysisQuery,normalizeFieldReportQuery
try {({normalizeAnalysisQuery,normalizeFieldReportQuery}=require('../lib/operations-field-analysis-query'))} catch(e) {if(e.code!=='MODULE_NOT_FOUND') throw e}
const now=new Date('2026-09-23T00:00:00Z'),a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64)
const pair=()=>({view:'pair',nodeGroupId:b,linkageId:'',dimensionIds:[a,c],filters:[]})
test('analysis query rejects duplicate filters and dimensions and preserves exact labels',()=>{
  assert.equal(typeof normalizeAnalysisQuery,'function')
  for(const analysis of [{...pair(),filters:[{dimensionId:a,value:'A'},{dimensionId:a,value:'B'}]},
    {...pair(),dimensionIds:[a,a]},{...pair(),extra:1},{...pair(),nodeGroupId:'raw-id'},
    {...pair(),filters:[{dimensionId:a,value:'x'.repeat(66000)}]}])
    assert.throws(()=>normalizeAnalysisQuery({analysis},now),{code:'VALIDATION_ERROR'})
  const q=normalizeAnalysisQuery({analysis:{...pair(),filters:[{dimensionId:a,value:' A\nB '}] }},now)
  assert.equal(q.analysis.filters[0].value,' A\nB ')
})
test('nested getters, prototypes, symbols, sparse arrays and unknown keys fail without executing',()=>{
  assert.equal(typeof normalizeAnalysisQuery,'function');let reads=0
  const getter=pair();Object.defineProperty(getter,'filters',{get(){reads++;return []}})
  const sym=pair();sym[Symbol('hidden')]=1
  for(const analysis of [getter,sym,Object.assign(Object.create({fake:1}),pair()),{...pair(),filters:Array(1)},
    {...pair(),filters:[Object.create({dimensionId:a,value:'A'})]}])
    assert.throws(()=>normalizeAnalysisQuery({analysis},now),{code:'VALIDATION_ERROR'})
  assert.equal(reads,0)
})
test('view arity and version boundaries do not loosen the legacy protocol',()=>{
  assert.equal(typeof normalizeFieldReportQuery,'function')
  const {normalizeFieldQuery}=require('../lib/operations-field-service')
  assert.throws(()=>normalizeFieldQuery({analysis:pair()},now),{code:'VALIDATION_ERROR'})
  for(const query of [{analysis:pair()},{reportVersion:1,analysis:pair()},{reportVersion:2},
    {reportVersion:2,analysis:{...pair(),view:'catalog'}},{reportVersion:2,analysis:{...pair(),view:'field'}}])
    assert.throws(()=>normalizeFieldReportQuery(query,now),{code:'VALIDATION_ERROR'})
  assert.equal(normalizeFieldReportQuery({reportVersion:2,analysis:pair()},now).reportVersion,2)
  assert.ok(!Object.hasOwn(normalizeFieldReportQuery({},now),'analysis'))
})
