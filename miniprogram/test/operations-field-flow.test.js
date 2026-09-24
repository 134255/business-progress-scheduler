const test=require('node:test')
const assert=require('node:assert/strict')
const path=require('node:path')
const domain=require('../../cloudfunctions/businessApi/lib/operations-field-domain')
const {fieldSource}=require('../../cloudfunctions/businessApi/test/helpers/field-fixtures')
const {record,selection}=require('../../cloudfunctions/businessApi/test/helpers/field-analysis-fixtures')
const {fieldAnalysisExportRows}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis')

const records=['A','A','B'].map((value,index)=>record(fieldSource({nodeId:`node-${index}`,
  values:[{fieldKey:'choice',value},{fieldKey:'tags',value:index===0?['X','Y']:index===1?['Y']:[]},
    {fieldKey:'amount',value:0},{fieldKey:'confirmed',value:false},{fieldKey:'note',value:'完整文字,含"引号"\n下一行'}]})))
const results=records.map(r=>r.result)
const summary={scope:'authorized',groups:domain.aggregateFieldResults(results),sampledNodeCount:3,incomplete:false}
const filters={templates:[{templateId:'template-1',templateName:'合成模板'}],templateVersions:[1],
  stableNodes:[{stableNodeId:'stable-node-1',nodeName:'节点',sequence:0}]}
const basic={businessCode:'BL-SYNTHETIC',businessName:'基本记录',recordType:'运营基础',dateBasis:'售后创建日期'}
const reportRows=[basic,...fieldAnalysisExportRows(records,selection(records,'catalog')).rows]
function harness(overrides={},role='super_admin') {
  const app={globalData:{currentUser:{_id:'actor',role,status:'active'}}}
  global.getApp=()=>app
  const calls=[],writes=[],shares=[]
  global.wx={reLaunch(){},env:{USER_DATA_PATH:'/synthetic'},
    getFileSystemManager:()=>({writeFile(input){writes.push(input);input.success()}}),
    shareFileMessage(input){shares.push(input);input.success({errMsg:'shareFileMessage:ok'})}}
  const handlers={getOperationsDashboard:()=>({stats:{}}),getOperationsAnalyticsFilters:()=>filters,
    getOperationsFieldFilters:()=>filters,getOperationsFieldSummary:()=>summary,
    getOperationsAnalyticsSummary:()=>({templateMetrics:{},nodeSeries:[{stableNodeId:'stable-node-1',nodeName:'节点',
      processing:{averageMinutes:3,sampleCount:1},review:{averageMinutes:1,sampleCount:1}}],trendSeries:[]}),
    exportOperationsReportRows:()=>({items:reportRows,hasMore:false,nextCursor:''}),...overrides}
  const cloudPath=require.resolve('../utils/cloud'),servicePath=require.resolve('../services/business'),pagePath=require.resolve('../pages/admin-operations/index')
  const saved=[cloudPath,servicePath,pagePath].map(p=>require.cache[p])
  let page
  require.cache[cloudPath]={id:cloudPath,filename:cloudPath,loaded:true,exports:{async callBusinessApi(action,payload,options){
    calls.push({action,payload,options});if(!handlers[action]) throw new Error('UNEXPECTED_ACTION:'+action);return handlers[action](payload)
  }}}
  delete require.cache[servicePath];delete require.cache[pagePath]
  global.Page=definition=>{page={...definition,data:structuredClone(definition.data),setData(update){Object.assign(this.data,update)}}}
  try{require(pagePath)}finally{delete global.Page;[cloudPath,servicePath,pagePath].forEach((p,i)=>{if(saved[i])require.cache[p]=saved[i];else delete require.cache[p]})}
  page.setData({startDate:'2026-09-01',endDate:'2026-09-11'})
  return {app,page,calls,writes,shares}
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}

test('obsolete template filter continuation cannot clear or invalidate the newer summary',async()=>{
  const oldFilters=deferred(),newSummary=deferred()
  const h=harness({getOperationsFieldFilters:query=>query.templateId==='A'?oldFilters.promise:filters,
    getOperationsFieldSummary:()=>newSummary.promise})
  h.page.setData({templateOptions:[{value:'A'},{value:'B'}]})
  const old=h.page.onTemplateChange({detail:{value:0}})
  await new Promise(resolve=>setImmediate(resolve))
  const latest=h.page.onTemplateChange({detail:{value:1}})
  await new Promise(resolve=>setImmediate(resolve))
  const sequence=h.page.fieldSequence
  oldFilters.resolve(filters)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(h.page.fieldSequence,sequence)
  assert.equal(h.calls.filter(c=>c.action==='getOperationsFieldSummary').length,0)
  newSummary.resolve(summary);await Promise.all([old,latest])
  assert.equal(h.page.data.fieldAnalysisEnabled,true)
  assert.equal(h.page.data.fieldAnalysisQuery.templateId,'B')
})

test('typed incomplete or invalid new report rows cannot become sendable files',async()=>{
  const detail=reportRows.find(row=>row.recordType==='字段明细')
  const total=reportRows.find(row=>row.recordType==='选项统计')
  const invalid=[{recordType:'字段明细'},{recordType:'选项统计'},
    {...detail,fieldGroupId:''},{...detail,fieldType:'unknown'},
    {...total,occurrenceCount:-1},{...total,occurrenceCount:total.filledSampleCount+1},
    {...total,optionValue:null},{...total,filledSampleCount:1.5}]
  for(const key of ['fieldValue','fieldKey','nodeCode','nodeCompletedAt','dataStatus']) {
    const row={...detail};delete row[key];invalid.push(row)
  }
  for(const row of invalid) {
    const h=harness({exportOperationsReportRows:()=>({items:[row],hasMore:false,nextCursor:''})})
    await h.page.exportCsv()
    assert.equal(h.writes.length,0,JSON.stringify(row))
    assert.equal(h.page.data.exportReady,false)
    assert.ok(h.page.data.exportErrorMessage)
  }
})

test('changing date during template filters discards the continuation and releases loading',async()=>{
  const pending=deferred()
  const h=harness({getOperationsFieldFilters:()=>pending.promise})
  h.page.setData({templateOptions:[{value:'template-1'}]})
  const work=h.page.onTemplateChange({detail:{value:0}})
  await new Promise(resolve=>setImmediate(resolve))
  h.page.onEndDateChange({detail:{value:'2026-09-10'}})
  pending.resolve(filters);await work
  assert.equal(h.calls.filter(c=>c.action==='getOperationsFieldSummary').length,0)
  assert.equal(h.page.data.fieldAnalysisEnabled,false)
  assert.equal(h.page.data.loading,false)
})

test('encoded CSV preserves reversible field and option originals including formula prefixes and newlines',async()=>{
  const labels=['line\nbreak','line\r\nbreak','=formula-option',"'=formula-option",'@option','comma,"quoted"']
  const source=fieldSource()
  for(const field of source.node.fieldDefinitions) {
    if(['choice','tags'].includes(field.fieldKey)) field.constraints.options=labels
  }
  source.feedback.fieldValues=require('../../cloudfunctions/businessApi/lib/field-domain').validateFieldValues(
    source.node.fieldDefinitions,[{fieldKey:'choice',value:labels[0]},{fieldKey:'tags',value:labels}])
  const records=[record(source)]
  const rows=fieldAnalysisExportRows(records,selection(records,'catalog')).rows
  const h=harness({exportOperationsReportRows:()=>({items:rows,hasMore:false,nextCursor:''})})
  await h.page.exportCsv();assert.equal(h.writes.length,1,h.page.data.exportErrorMessage)
  const [header,...cells]=parseCsv(h.writes[0].data)
  const col=name=>header.indexOf(name)
  assert.ok(col('字段或选项原文（JSON）')>=0)
  const counted=new Map()
  for(const row of cells) if(row[col('记录类型')]==='字段明细') {
    const original=JSON.parse(row[col('字段或选项原文（JSON）')])
    for(const label of Array.isArray(original)?original:[original]) {
      const key=JSON.stringify([row[col('字段兼容组')],label]);counted.set(key,(counted.get(key)||0)+1)
    }
  }
  for(const row of cells.filter(row=>row[col('记录类型')]==='选项统计')) {
    const original=JSON.parse(row[col('字段或选项原文（JSON）')])
    assert.equal(Number(row[col('出现次数')]),counted.get(JSON.stringify([row[col('字段兼容组')],original]))||0)
    if(original.startsWith('=')) assert.equal(row[col('选项内容')],"'"+original)
  }
})

test('page supplies only committed filters to the independent authorized analysis component',async()=>{
  const h=harness({},'user');await h.page.onShow()
  assert.equal(h.page.data.fieldAnalysisEnabled,true)
  assert.equal(h.page.data.fieldAnalysisQuery.templateId,'template-1')
  assert.doesNotMatch(JSON.stringify(h.page.data),/完整文字/)
  assert.ok(!h.calls.some(c=>c.action==='getOperationsFieldSummary'))
  assert.ok(h.calls.every(c=>c.options.silent===true))
})

test('independent analysis access failure clears field visibility but preserves timing charts',async()=>{
  const h=harness({getOperationsFieldSummary(){throw Object.assign(new Error('private detail'),{code:'RANGE_TOO_LARGE'})}})
  await h.page.onShow()
  assert.equal(h.page.data.nodeSeries.length,1)
  h.page.onFieldAnalysisAccessInvalid()
  assert.equal(h.page.data.fieldAnalysisEnabled,false)
  assert.equal(h.page.data.nodeSeries.length,1)
})

test('historical instance field templates are available even without timing template candidates',async()=>{
  const h=harness({getOperationsAnalyticsFilters:()=>({templates:[]})})
  await h.page.onShow()
  assert.equal(h.page.data.templateOptions[0].value,'template-1')
  assert.equal(h.page.data.fieldAnalysisEnabled,true)
})

test('field-only business and participant candidates are merged into the actual selectors',async()=>{
  const h=harness({getOperationsAnalyticsFilters:()=>({templates:[]}),getOperationsFieldFilters:()=>({...filters,
    businesses:[{businessLineId:'line-1',businessCode:'BL-1',businessName:'合成售后'}],
    processors:[{token:'a'.repeat(64),displayName:'实际处理人'}],reviewers:[{token:'b'.repeat(64),displayName:'实际审核人'}]})})
  await h.page.onShow()
  assert.equal(h.page.data.businessOptions[1].value,'line-1')
  assert.equal(h.page.data.processorOptions[1].value,'a'.repeat(64))
  assert.equal(h.page.data.reviewerOptions[1].value,'b'.repeat(64))
})

test('applying a changed date range refreshes historical templates, versions and nodes while preserving valid selections',async()=>{
  const h=harness({getOperationsAnalyticsFilters:()=>({templates:[]}),getOperationsFieldFilters:query=>({
    templates:query.startDate==='2026-08-01'?[{templateId:'A',templateName:'九月'},{templateId:'B',templateName:'八月'}]:[{templateId:'A',templateName:'九月'}],
    templateVersions:query.startDate==='2026-08-01'?[1,2]:[1],stableNodes:query.startDate==='2026-08-01'?
      [{stableNodeId:'old-node',nodeName:'节点一',sequence:0},{stableNodeId:'new-node',nodeName:'节点二',sequence:1}]:[{stableNodeId:'old-node',nodeName:'节点一',sequence:0}]})})
  await h.page.onShow()
  h.page.onVersionChange({detail:{value:1}});h.page.onNodeChange({detail:{value:1}})
  h.page.onStartDateChange({detail:{value:'2026-08-01'}})
  const before=h.calls.filter(c=>c.action==='getOperationsFieldFilters').length
  await h.page.applyFilters()
  assert.ok(h.calls.filter(c=>c.action==='getOperationsFieldFilters').length>before)
  assert.deepEqual(h.page.data.templateOptions.map(o=>o.value),['A','B'])
  assert.equal(h.page.query().templateId,'A')
  assert.equal(h.page.query().templateVersion,1)
  assert.equal(h.page.query().stableNodeId,'old-node')
  assert.deepEqual(h.page.data.versionOptions.map(o=>o.value),['','2','1'])
  assert.deepEqual(h.page.data.nodeOptions.map(o=>o.value),['','old-node','new-node'])
  await h.page.onTemplateChange({detail:{value:1}})
  assert.equal(h.page.query().templateId,'B')
})

test('an initially empty date range can discover history, and vanished selections reset safely',async()=>{
  const h=harness({getOperationsAnalyticsFilters:()=>({templates:[]}),getOperationsFieldFilters:query=>query.startDate==='2026-08-01'?
    {templates:[{templateId:'historical',templateName:'历史模板'}],templateVersions:[3],stableNodes:[{stableNodeId:'historical-node',nodeName:'历史节点',sequence:0}]}:{templates:[]}})
  await h.page.onShow();assert.equal(h.page.data.templateOptions.length,0)
  const wxml=require('node:fs').readFileSync(path.join(__dirname,'../pages/admin-operations/index.wxml'),'utf8')
  assert.doesNotMatch(wxml.match(/<button[^>]*bindtap="applyFilters"[^>]*>/)[0],/!templateOptions.length/)
  h.page.onStartDateChange({detail:{value:'2026-08-01'}});await h.page.applyFilters()
  assert.equal(h.page.query().templateId,'historical')
  h.page.onVersionChange({detail:{value:1}});h.page.onNodeChange({detail:{value:1}})
  h.page.onStartDateChange({detail:{value:'2026-09-01'}});await h.page.applyFilters()
  assert.equal(h.page.query().templateId,'');assert.equal(h.page.query().templateVersion,undefined)
  assert.equal(h.page.query().stableNodeId,'');assert.equal(h.page.data.loading,false)
})

for(const change of ['account','filter','hide']) test(`late field-filter response cannot activate analysis on ${change}`,async()=>{
  const wait=deferred()
  const h=harness({getOperationsFieldFilters:()=>wait.promise})
  h.page.setData({templateOptions:[{value:'template-1'}]})
  const loading=h.page.applyFilters()
  await new Promise(resolve=>setImmediate(resolve))
  if(change==='account') h.app.globalData.currentUser={...h.app.globalData.currentUser}
  if(change==='filter') h.page.onEndDateChange({detail:{value:'2026-09-10'}})
  if(change==='hide') h.page.onHide()
  wait.resolve(filters);await loading
  assert.equal(h.page.data.fieldAnalysisEnabled,false)
})

test('legacy statistics formatter keeps the old incomplete protocol available for old clients',()=>{
  const result=require('../utils/operations-field-report').formatFieldSummary({...summary,incomplete:true})
  assert.equal(result.fieldIncomplete,true)
  assert.match(result.fieldNotice,/补齐|不完整/)
})

test('combined CSV keeps original columns and actual typed detail/count rows in the existing two-tap flow',async()=>{
  const h=harness();h.page.setData({templateOptions:[{value:'template-1'}],nodeOptions:[{value:'stable-node-1'}]})
  await h.page.exportCsv()
  assert.equal(h.writes.length,1);assert.equal(h.shares.length,0)
  const csv=h.writes[0].data
  assert.ok(csv.startsWith('\uFEFF售后编号,售后名称,售后状态,节点编号,节点名称,节点状态,流程模式,审核模式,'))
  assert.match(csv,/节点完成时间,记录类型,筛选日期口径/)
  assert.match(csv,/字段明细/);assert.match(csv,/选项统计/)
  assert.match(csv,/完整文字/);assert.match(csv,/否/)
  assert.match(csv,/\[""X"",""Y""\]/)
  const call=h.calls.find(c=>c.action==='exportOperationsReportRows')
  assert.equal(call.payload.templateId,'template-1');assert.equal(call.payload.stableNodeId,'stable-node-1')
  h.page.exportCsv();assert.equal(h.shares.length,1)
  assert.equal(h.calls.filter(c=>c.action==='exportOperationsReportRows').length,1)
})

test('source changed during pagination leaves no partial CSV file or sendable state',async()=>{
  let count=0
  const h=harness({exportOperationsReportRows(){if(count++===0)return {items:[basic],hasMore:true,nextCursor:'opaque-1'}
    throw Object.assign(new Error('private'),{code:'REPORT_CHANGED'})}})
  await h.page.exportCsv()
  assert.equal(h.writes.length,0);assert.equal(h.page.data.exportReady,false)
  assert.match(h.page.data.exportErrorMessage,/变化|重新/)
})

test('report pagination rejects cycling cursors and malformed report rows',async()=>{
  for(const malformed of [false,true]) {
    let count=0
    const h=harness({exportOperationsReportRows(){return {items:malformed?[null]:[basic],hasMore:true,nextCursor:['a','b','a'][count++%3]}}})
    await h.page.exportCsv()
    assert.equal(h.writes.length,0);assert.equal(h.page.data.exportReady,false)
    assert.ok(h.page.data.exportErrorMessage)
    assert.ok(count<=3)
  }
})

test('a report row without its record type cannot become a sendable supposedly complete file',async()=>{
  const h=harness({exportOperationsReportRows:()=>({items:[{businessCode:'untyped'}],hasMore:false,nextCursor:''})})
  await h.page.exportCsv()
  assert.equal(h.writes.length,0)
  assert.equal(h.page.data.exportReady,false)
})

test('field and timing loading do not require Promise.allSettled on a mini-program runtime',async()=>{
  const saved=Promise.allSettled
  Promise.allSettled=undefined
  try {const h=harness();await h.page.onShow();assert.equal(h.page.data.fieldAnalysisEnabled,true);assert.equal(h.page.data.nodeSeries.length,1)}
  finally {Promise.allSettled=saved}
})

function parseCsv(csv) {
  const rows=[];let row=[],cell='',quoted=false
  for(let i=1;i<csv.length;i++) {
    const char=csv[i]
    if(char==='"') {if(quoted && csv[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
    else if(char===',' && !quoted){row.push(cell);cell=''}
    else if(char==='\r' && csv[i+1]==='\n' && !quoted){row.push(cell);rows.push(row);row=[];cell='';i++}
    else cell+=char
  }
  row.push(cell);rows.push(row)
  return rows
}

test('real field repository and service feed client CSV whose select detail exactly reproduces exported counts',async()=>{
  const {createFakeCloudDatabase}=require('../../cloudfunctions/businessApi/test/helpers/fake-cloud-database')
  const {createCloudOperationsRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-repository')
  const {createCloudOperationsFieldRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-field-repository')
  const {createOperationsFieldService}=require('../../cloudfunctions/businessApi/lib/operations-field-service')
  const actor={_id:'actor',role:'super_admin',status:'active'}
  const sources=[fieldSource({nodeId:'node-a',reviewed:true}),fieldSource({nodeId:'node-b',reviewed:true})]
  const line={...sources[0].line,traversedNodeIds:sources.map(s=>s.node._id)}
  const fake=createFakeCloudDatabase({users:[actor],business_lines:[line],business_nodes:sources.map(s=>s.node),node_feedback:sources.map(s=>s.feedback),
    node_review_rounds:sources.map(s=>s.round),node_review_votes:sources.flatMap(s=>s.votes)})
  const clock=()=>new Date('2026-09-11T03:00:00Z')
  const service=createOperationsFieldService({clock,repository:createCloudOperationsFieldRepository({db:fake.db,
    operationsRepository:createCloudOperationsRepository({db:fake.db}),secret:'synthetic-integration-key'.repeat(3),clock})})
  const h=harness({getOperationsFieldSummary:query=>service.getSummary({actor,query}),
    getOperationsFieldFilters:query=>service.getFilters({actor,query}),
    exportOperationsReportRows:query=>service.exportReportRows({actor,query})})
  h.app.globalData.currentUser=actor
  await h.page.onShow();await h.page.exportCsv()
  assert.equal(h.page.data.businessOptions[1].value,line._id)
  assert.deepEqual(h.page.data.processorOptions.slice(1).map(o=>o.label),['合成处理人二'])
  assert.deepEqual(h.page.data.reviewerOptions.slice(1).map(o=>o.label),['合成审核人一'])
  assert.equal(h.writes.length,1,h.page.data.exportErrorMessage)
  const [header,...rows]=parseCsv(h.writes[0].data)
  const col=name=>header.indexOf(name)
  const counted=new Map()
  for(const row of rows) if(row[col('记录类型')]==='字段明细') {
    const type=row[col('字段类型')],value=row[col('字段内容')],group=row[col('字段兼容组')]
    if(type==='single_select' && value) counted.set(group+'|'+value,(counted.get(group+'|'+value)||0)+1)
    if(type==='multi_select' && value) for(const option of JSON.parse(value)) counted.set(group+'|'+option,(counted.get(group+'|'+option)||0)+1)
    assert.equal(row[col('处理累计工作分钟')],'')
  }
  const totals=rows.filter(row=>row[col('记录类型')]==='选项统计')
  assert.ok(totals.length>0)
  for(const row of totals) assert.equal(Number(row[col('出现次数')]),counted.get(row[col('字段兼容组')]+'|'+row[col('选项内容')])||0)
  assert.ok(rows.some(row=>row[col('字段标识')]==='amount' && row[col('字段内容')]==='0'))
  assert.ok(rows.some(row=>row[col('字段标识')]==='confirmed' && row[col('字段内容')]==='否'))
  const legacy=await service.getSummary({actor,query:h.page.query()})
  assert.equal(legacy.groups.find(g=>g.fieldKey==='choice').options.find(o=>o.label==='A').count,2)
})
