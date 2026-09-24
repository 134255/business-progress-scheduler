const test=require('node:test'),assert=require('node:assert/strict')
const domain=require('../lib/operations-field-domain')
const {buildFieldAnalysis,fieldAnalysisExportRows}=require('../lib/operations-field-analysis')
const {analysisRecords,selection,record,productRecords}=require('./helpers/field-analysis-fixtures')
const {fieldSource}=require('./helpers/field-fixtures')
const {analysisHarness,admin}=require('./helpers/field-analysis-repository-fixture')
test('v2 associations match analysis while legacy rows retain their shape',()=>{
  assert.equal(typeof fieldAnalysisExportRows,'function')
  const records=analysisRecords(),input=selection(records,'pair',['choice','tags'])
  const report=fieldAnalysisExportRows(records,input),stats=report.rows.filter(r=>r.recordType==='关联统计')
  assert.deepEqual(stats.map(r=>[JSON.parse(r.dimensionValuesJson),r.occurrenceCount]),[[['A','Y'],2],[['A','X'],1]])
  assert.ok(stats.every(r=>r.filledSampleCount===2 && r.emptySampleCount===1 && r.notApplicableSampleCount===0))
  assert.ok(domain.fieldExportRows(records.map(r=>r.result)).every(r=>r.recordType!=='关联统计'))
  assert.ok(report.rows.filter(r=>r.recordType==='选项统计').every(r=>r.occurrenceCount>0))
})
test('v2 filtered details retain all field types, zero, false and blank values',()=>{
  assert.equal(typeof fieldAnalysisExportRows,'function')
  const rows=[record(fieldSource()),record(fieldSource({nodeId:'second',values:[{fieldKey:'choice',value:'B'}]}))]
  const input=selection(rows,'node',[],{filters:[{dimensionId:rows[0].schema.dimensions[0].id,value:'A'}]})
  const report=fieldAnalysisExportRows(rows,input),details=report.rows.filter(r=>r.recordType==='字段明细')
  assert.equal(details.length,7);assert.deepEqual(report.matchedNodeIds,['node-1'])
  assert.equal(details.find(r=>r.fieldKey==='amount').fieldValue,'0')
  assert.equal(details.find(r=>r.fieldKey==='confirmed').fieldValue,'否')
  assert.equal(details.find(r=>r.fieldKey==='note').fieldValue,'完整说明')
  assert.ok(details.every(r=>JSON.parse(r.analysisContextJson).filters[0].value==='A'))
})
test('full export counts are not limited by the ten item preview and labels retain identity',()=>{
  assert.equal(typeof fieldAnalysisExportRows,'function')
  const options=Array.from({length:12},(_,i)=>String(i)),labels=['=formula', 'a,b','a"b','a\r\nb',' A ']
  // Non-linkage options permit exact embedded punctuation; leading spaces are
  // normalized by field definitions, so use a permitted literal for this fixture.
  options.push(...labels.slice(0,4))
  const rows=options.map((value,i)=>record(fieldSource({nodeId:`record-${i}`,node:{fieldDefinitions:[
    {fieldKey:'choice',name:'选项',type:'single_select',constraints:{options}}]},values:[{fieldKey:'choice',value}]})))
  const input=selection(rows,'field',['choice']),report=fieldAnalysisExportRows(rows,input)
  const stats=report.rows.filter(r=>r.recordType==='选项统计')
  assert.equal(stats.length,16);assert.equal(buildFieldAnalysis(rows,selection(rows,'node')).items[0].options.length,10)
  assert.ok(stats.some(r=>r.optionValue==='a\r\nb'))
})
test('v2 repository preserves legacy base date range and binds export version and analysis',async()=>{
  const h=analysisHarness(),analysis=selection(h.records,'pair',['choice','tags'])
  const range={...h.range,analysis,reportVersion:2}
  const report=await h.repository.exportReportRows({actor:admin,range})
  assert.ok(report.items.some(r=>r.recordType==='关联统计'))
  assert.equal(report.items[0].dateBasis,'售后创建日期');assert.equal(report.items[0].processingElapsedWorkMinutes,7)
  assert.ok(h.baseRanges.every(r=>!Object.hasOwn(r,'analysis') && !Object.hasOwn(r,'reportVersion')))
  const first=await h.repository.exportReportRows({actor:admin,range:{...range,pageSize:1}})
  for(const changed of [{...range,analysis:selection(h.records,'node')},((r)=>{delete r.reportVersion;delete r.analysis;return r})({...range})])
    await assert.rejects(h.repository.exportReportRows({actor:admin,range:{...changed,cursor:first.nextCursor}}),{code:'VALIDATION_ERROR'})
})
test('v2 report continuation rejects an unmatched source becoming matched and any incomplete result',async()=>{
  const h=analysisHarness(),choice=h.records[0].schema.dimensions[0].id
  const range={...h.range,reportVersion:2,pageSize:1,analysis:selection(h.records,'pair',['choice','tags'],{filters:[{dimensionId:choice,value:'A'}]})}
  const first=await h.repository.exportReportRows({actor:admin,range})
  const f=structuredClone(h.sources[2].feedback);f.fieldValues.find(f=>f.fieldKey==='choice').value='A';h.fake.replace('node_feedback',f._id,f)
  await assert.rejects(h.repository.exportReportRows({actor:admin,range:{...range,cursor:first.nextCursor}}),{code:'REPORT_CHANGED'})
  h.fake.replace('business_nodes',h.sources[2].node._id,{...h.sources[2].node,latestFeedbackId:'missing'})
  await assert.rejects(h.repository.exportReportRows({actor:admin,range}),{code:'INCOMPLETE_FIELD_DATA'})
})
test('actual attribute tuples and denominators remain aligned in export with non-applicable holes',()=>{
  assert.equal(typeof fieldAnalysisExportRows,'function')
  const rows=productRecords(),link=rows[0].schema.linkages[0]
  const filters=link.dimensionIds.slice(0,3).map((dimensionId,i)=>({dimensionId,value:['椅类','品牌甲','型号一'][i]}))
  const report=fieldAnalysisExportRows(rows,selection(rows,'combinations',[],{linkageId:link.id,filters}))
  const [stat]=report.rows.filter(r=>r.recordType==='关联统计')
  assert.deepEqual(JSON.parse(stat.dimensionValuesJson),['黑','带头枕']);assert.equal(stat.occurrenceCount,2)
  assert.equal(stat.filledSampleCount,2);assert.equal(JSON.parse(stat.dimensionIdsJson).length,2)
})
test('v2 option groups stay separate when only a condition ancestor changes meaning',()=>{
  const rows=[[],['C']].map((extra,i)=>record(fieldSource({nodeId:`ancestor-${i}`,node:{fieldDefinitions:[
    {fieldKey:'parent',name:'父',type:'single_select',sequence:0,constraints:{options:['A','B',...extra]}},
    {fieldKey:'child',name:'子',type:'single_select',sequence:1,constraints:{options:['X']},condition:{parentFieldKey:'parent',visibleWhen:['A']}}
  ]},values:[{fieldKey:'parent',value:'A'},{fieldKey:'child',value:'X'}]})))
  const report=fieldAnalysisExportRows(rows,selection(rows,'node'))
  const stats=report.rows.filter(r=>r.recordType==='选项统计' && r.fieldKey==='child')
  assert.deepEqual(stats.map(r=>r.occurrenceCount),[1,1]);assert.notEqual(stats[0].analysisGroupId,stats[1].analysisGroupId)
  const details=report.rows.filter(r=>r.recordType==='字段明细' && r.fieldKey==='child')
  assert.deepEqual(new Set(details.map(r=>r.analysisGroupId)),new Set(stats.map(r=>r.analysisGroupId)))
})
test('repeated verified node cannot inflate v2 option statistics',()=>{
  const rows=analysisRecords(),query=selection(rows,'catalog')
  const expected=fieldAnalysisExportRows(rows,query)
  assert.deepEqual(fieldAnalysisExportRows([...rows,rows[0]],query),expected)
})

test('association template versions name only records declaring every selected dimension',()=>{
  const rows=[1,2].map(version=>record(fieldSource({nodeId:`version-${version}`,line:{sourceTemplateVersion:version},node:{fieldDefinitions:[
    {fieldKey:'choice',name:'单选',type:'single_select',constraints:{options:version===1?['A','B']:['A','B','C']}},
    {fieldKey:'tags',name:'多选',type:'multi_select',constraints:{options:['X','Y','Z']}}
  ]},values:[{fieldKey:'choice',value:'A'},{fieldKey:'tags',value:['X']}]})))
  const stats=fieldAnalysisExportRows(rows,selection(rows,'pair',['choice','tags'])).rows.filter(r=>r.recordType==='关联统计')
  assert.equal(stats[0].filledSampleCount,1);assert.equal(stats[0].templateVersions,'1')
})
