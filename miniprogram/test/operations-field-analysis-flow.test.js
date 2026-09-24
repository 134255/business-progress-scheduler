const test=require('node:test'),assert=require('node:assert/strict')
const {harness}=require('./helpers/operations-analysis-page-harness')
const {fieldAnalysisExportRows}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis')
test('page applies independent analysis props, sends v2 selection and invalidates CSV when selection changes',async()=>{
  const h=harness();await h.page.onShow()
  assert.equal(h.page.data.fieldAnalysisEnabled,true)
  assert.equal(h.calls.filter(c=>c.action==='getOperationsFieldSummary').length,0)
  const pair=h.selection(h.records,'pair',['choice','tags'])
  h.page.onFieldAnalysisChange({detail:{selection:pair}})
  await h.page.exportCsv()
  assert.equal(h.calls.find(c=>c.action==='exportOperationsReportRows').payload.reportVersion,2)
  assert.equal(h.writes.length,1);assert.equal(h.shares.length,0)
  h.page.exportCsv();assert.equal(h.shares.length,1)
  h.shares[0].success({});assert.equal(h.page.data.exportReady,true)
  h.page.onFieldAnalysisChange({detail:{selection:h.selection(h.records,'node')}})
  assert.equal(h.page.data.exportReady,false)
  assert.ok(h.calls.filter(c=>c.action==='getOperationsAnalyticsSummary').every(c=>!('analysis' in c.payload) && !('reportVersion' in c.payload)))
})
test('native share hide/show preserves legitimate callback but real account or filter changes invalidate it',async()=>{
  for(const change of ['native','account','filter']) {
    const h=harness();await h.page.onShow();h.page.onFieldAnalysisChange({detail:{selection:h.selection(h.records,'pair',['choice','tags'])}})
    await h.page.exportCsv();h.page.exportCsv();h.page.onHide()
    if(change==='account')h.app.globalData.currentUser={...h.app.globalData.currentUser}
    if(change==='filter')h.page.onEndDateChange({detail:{value:'2026-09-22'}})
    if(change==='native')await h.page.onShow()
    h.shares[0].success({})
    assert.equal(h.page.data.exportReady,change==='native',change)
    assert.equal(h.page.data.exportSending,false)
  }
})
test('editing dates clears old analysis and does not silently apply new filters to old charts',async()=>{
  const h=harness();await h.page.onShow()
  const before=structuredClone(h.page.data.fieldAnalysisQuery)
  h.page.onEndDateChange({detail:{value:'2026-09-22'}})
  assert.equal(h.page.data.fieldAnalysisEnabled,false)
  assert.deepEqual(h.page.data.fieldAnalysisQuery,before)
  await h.page.applyFilters();assert.equal(h.page.data.fieldAnalysisQuery.endDate,'2026-09-22')
})
test('invalid association rows cannot write files, and JSON dimensions survive CSV',async()=>{
  const h=harness();const input=h.selection(h.records,'pair',['choice','tags'])
  const row=fieldAnalysisExportRows(h.records,input).rows.find(r=>r.recordType==='关联统计')
  const invalid=[{...row,dimensionValuesJson:'["A"]'},{...row,dimensionIdsJson:'["raw","raw"]'},
    {...row,occurrenceCount:3},{...row,notApplicableSampleCount:-1},{...row,analysisContextJson:'{}'}]
  for(const bad of invalid) {
    const h=harness({exportOperationsReportRows:()=>({items:[bad],hasMore:false,nextCursor:''})});await h.page.onShow()
    h.page.onFieldAnalysisChange({detail:{selection:input}});await h.page.exportCsv()
    assert.equal(h.writes.length,0);assert.equal(h.page.data.exportReady,false)
  }
  const good=harness();await good.page.onShow();good.page.onFieldAnalysisChange({detail:{selection:input}});await good.page.exportCsv()
  assert.match(good.writes[0].data,/关联统计/);assert.match(good.writes[0].data,/维度值原文/)
  assert.match(good.writes[0].data,/\[""A"",""Y""\]/)
})
test('analysis access invalidation drops sensitive component state and pending file reference',async()=>{
  const h=harness();await h.page.onShow();await h.page.exportCsv();assert.equal(h.page.data.exportReady,true)
  h.page.onFieldAnalysisAccessInvalid()
  assert.equal(h.page.data.fieldAnalysisEnabled,false);assert.equal(h.page.csvExport,null)
})
test('first explicit generate establishes a finite analysis epoch even before onShow',async()=>{
  const h=harness();await h.page.applyFilters()
  assert.equal(Number.isSafeInteger(h.page.data.fieldAnalysisSessionEpoch),true)
})

test('valid rows for another analysis context cannot become a sendable CSV',async()=>{
  const fixture=harness(),wrong=fieldAnalysisExportRows(fixture.records,fixture.selection(fixture.records,'node')).rows
  const h=harness({exportOperationsReportRows:()=>({items:wrong,hasMore:false,nextCursor:''})})
  await h.page.onShow();h.page.onFieldAnalysisChange({detail:{selection:h.selection(h.records,'pair',['choice','tags'])}})
  await h.page.exportCsv();assert.equal(h.writes.length,0)
})

test('v2 fails closed for missing context or mandatory analysis metadata while old validator stays compatible',async()=>{
  const fixture=harness(),input=fixture.selection(fixture.records,'node')
  const rows=fieldAnalysisExportRows(fixture.records,input).rows
  const detail=rows.find(r=>r.recordType==='字段明细' && r.fieldType==='single_select')
  const stat=rows.find(r=>r.recordType==='选项统计')
  for(const [row,key] of [[detail,'analysisContextJson'],[detail,'analysisGroupId'],[stat,'analysisGroupId'],[stat,'notApplicableSampleCount']]){
    const bad={...row};delete bad[key]
    const h=harness({exportOperationsReportRows:()=>({items:[bad],hasMore:false,nextCursor:''})});await h.page.onShow()
    h.page.onFieldAnalysisChange({detail:{selection:input}});await h.page.exportCsv();assert.equal(h.writes.length,0,key)
  }
  const legacy={...detail};delete legacy.analysisContextJson;delete legacy.analysisGroupId
  assert.equal(require('../utils/operations-field-report').validReportPage({items:[legacy],hasMore:false}),true)
})
