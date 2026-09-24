'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const domain = require('../lib/operations-field-domain')
const {fieldSource} = require('./helpers/field-fixtures')
const {record,analysisRecords,productRecords,selection} = require('./helpers/field-analysis-fixtures')
let buildFieldAnalysis
try { ({buildFieldAnalysis}=require('../lib/operations-field-analysis')) } catch (error) { if(error.code!=='MODULE_NOT_FOUND') throw error }
test('pair counts actual co-occurrence, not the product of marginal totals',()=>{
  const rows=analysisRecords(), out=buildFieldAnalysis(rows,selection(rows,'pair',['choice','tags']))
  assert.deepEqual(out.items,[{values:['A','Y'],count:2},{values:['A','X'],count:1}])
  assert.deepEqual([out.sampleCount,out.filledSampleCount,out.emptySampleCount,out.notApplicableSampleCount],[3,2,1,0])
})
test('node previews omit zero options and empty fields, catalogue omits entirely empty nodes',()=>{
  const rows=analysisRecords(),out=buildFieldAnalysis(rows,selection(rows,'node'))
  assert.equal(out.items.length,2)
  assert.deepEqual(out.items.find(i=>i.fieldKey==='tags').options.map(i=>i.label),['Y','X'])
  const empty=[record(fieldSource({values:[]}))]
  assert.deepEqual(buildFieldAnalysis(empty,selection(empty,'catalog')).items,[])
})
test('same node is counted once, conflicting copies and duplicate values reject',()=>{
  const rows=analysisRecords(),input=selection(rows,'field',['choice'])
  assert.equal(buildFieldAnalysis([...rows,rows[0]],input).sampleCount,3)
  const bad=structuredClone(rows[0]);bad.result.fields[0].value='B'
  assert.throws(()=>buildFieldAnalysis([...rows,bad],input),{code:'FIELD_SOURCE_INVALID'})
  const duplicate=structuredClone(rows[0]);duplicate.result.fields[1].value=['X','X']
  assert.throws(()=>buildFieldAnalysis([duplicate],input),{code:'FIELD_SOURCE_INVALID'})
})
test('schema is select-only, source-bound, and leaves legacy result/snapshot unchanged',()=>{
  const source=fieldSource(),result=domain.buildFinalFieldResult(source),before=JSON.stringify(result)
  const old=domain.selectionSnapshot(result),schema=domain.describeFieldAnalysisSource(source,result)
  assert.deepEqual(schema.dimensions.map(i=>i.fieldKey),['choice','tags'])
  assert.equal(JSON.stringify(result),before)
  assert.deepEqual(domain.selectionSnapshot(result),old)
  assert.ok(!JSON.stringify(schema).includes('options'))
  source.node.fieldDefinitions[0].constraints.options.push('C')
  assert.throws(()=>domain.describeFieldAnalysisSource(source,result),{code:'FIELD_SOURCE_INVALID'})
})
test('compatible versions merge but different templates and stable nodes stay distinct',()=>{
  const a=record(fieldSource()),b=record(fieldSource({nodeId:'node-2',line:{sourceTemplateVersion:2}}))
  assert.equal(a.schema.dimensions[0].id,b.schema.dimensions[0].id)
  const c=record(fieldSource({nodeId:'node-3',line:{sourceTemplateId:'other'}}))
  const d=record(fieldSource({nodeId:'node-4',node:{sourceTemplateNodeKey:'other-node'}}))
  assert.equal(buildFieldAnalysis([a,b,c,d],selection([a],'catalog')).items.length,3)
  assert.deepEqual(buildFieldAnalysis([a,b],selection([a],'node')).dimensionMetadata[0].templateVersions,[1,2])
})
test('ancestor option meaning changes separate descendant dimensions',()=>{
  function source(extra) { return fieldSource({values:[{fieldKey:'parent',value:'A'},{fieldKey:'child',value:'X'}],
    node:{fieldDefinitions:[{fieldKey:'parent',name:'父',type:'single_select',sequence:0,constraints:{options:['A','B',...extra]}},
      {fieldKey:'child',name:'子',type:'single_select',sequence:1,constraints:{options:['X']},condition:{parentFieldKey:'parent',visibleWhen:['A']}}]}}) }
  const a=record(source([])),b=record(source(['C']))
  assert.notEqual(a.schema.dimensions[1].id,b.schema.dimensions[1].id)
})
test('product prefix isolates brands and same-name models, attributes preserve holes and actual tuples',()=>{
  const rows=productRecords(),link=rows[0].schema.linkages[0],filter=link.dimensionIds.slice(0,3).map((dimensionId,i)=>
    ({dimensionId,value:['椅类','品牌甲','型号一'][i]}))
  const first=buildFieldAnalysis(rows,selection(rows,'product',[],{linkageId:link.id,filters:filter.slice(0,1)}))
  assert.deepEqual(first.items,[{values:['品牌甲'],count:2}])
  const attrs=buildFieldAnalysis(rows,selection(rows,'product',[],{linkageId:link.id,filters:filter}))
  assert.equal(attrs.productStage,'attributes')
  assert.deepEqual(attrs.items.map(i=>i.fieldKey),['color','headrest'])
  const combo=buildFieldAnalysis(rows,selection(rows,'combinations',[],{linkageId:link.id,filters:filter}))
  assert.deepEqual(combo.items,[{values:['黑','带头枕'],count:2}])
  assert.deepEqual(combo.dimensionMetadata.map(i=>i.fieldKey),['color','headrest'])
})
test('linkage semantic reorder merges but changed allowed tuple separates',()=>{
  const original=productRecords()[0],source=structuredClone(original.source)
  source.node.fieldDefinitions[0].optionLinkage.rows.reverse()
  source.node.fieldDefinitions[0].constraints.options.reverse()
  source.node.fieldDefinitions[0].optionLinkage.rows.forEach(row=>row[0]=1-row[0])
  assert.equal(record(source).schema.linkages[0].id,original.schema.linkages[0].id)
  source.node.fieldDefinitions[0].optionLinkage.rows[0][3]=0
  assert.notEqual(record(source).schema.linkages[0].id,original.schema.linkages[0].id)
})
test('pair counts not applicable separately and excludes incompatible dimensions',()=>{
  const rows=productRecords(),out=buildFieldAnalysis(rows,selection(rows,'pair',['color','headrest']))
  assert.deepEqual([out.filledSampleCount,out.emptySampleCount,out.notApplicableSampleCount],[2,0,1])
  assert.throws(()=>buildFieldAnalysis(rows,selection(rows,'pair',['color','headrest'],{dimensionIds:['a'.repeat(64),'b'.repeat(64)]})),{code:'VALIDATION_ERROR'})
})
test('preview top ten preserves complete sorted field result and denominator',()=>{
  const options=Array.from({length:12},(_,i)=>String(i).padStart(2,'0'))
  const rows=options.map((value,i)=>record(fieldSource({nodeId:`many-${i}`,values:[{fieldKey:'choice',value}],
    node:{fieldDefinitions:[{fieldKey:'choice',name:'选项',type:'single_select',constraints:{options}}]}})))
  const node=buildFieldAnalysis(rows,selection(rows,'node'))
  assert.equal(node.items[0].options.length,10);assert.equal(node.items[0].totalOptionCount,12)
  assert.equal(buildFieldAnalysis(rows,selection(rows,'field',['choice'])).items.length,12)
})
test('pair contribution budget rejects 50625 before enumeration and allows exactly 50000',()=>{
  function rows(n,m) { const defs=[n,m].map((length,i)=>({fieldKey:`f${i}`,name:`多选${i}`,type:'multi_select',
    sequence:i,constraints:{options:Array.from({length},(_,j)=>`v${j}`)}}))
    return [record(fieldSource({node:{fieldDefinitions:defs},values:defs.map(d=>({fieldKey:d.fieldKey,value:d.constraints.options}))}))] }
  const bad=rows(225,225)
  assert.throws(()=>buildFieldAnalysis(bad,selection(bad,'pair',['f0','f1'])),{code:'RANGE_TOO_LARGE'})
  const good=rows(200,250)
  assert.equal(buildFieldAnalysis(good,selection(good,'pair',['f0','f1'])).items.length,50000)
})
