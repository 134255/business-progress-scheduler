const test=require('node:test'),assert=require('node:assert/strict')
const {analysisHarness,admin,staff}=require('./helpers/field-analysis-repository-fixture')
const {selection}=require('./helpers/field-analysis-fixtures')
const domain=require('../lib/operations-field-domain')
test('new analysis queries only current authorized sources and makes no writes',async()=>{
  const h=analysisHarness();assert.equal(typeof h.repository.getAnalysis,'function')
  const own=await h.repository.getAnalysis({actor:staff,range:h.range}),all=await h.repository.getAnalysis({actor:admin,range:h.range})
  assert.equal(own.scope,'authorized');assert.equal(own.sampleCount,1);assert.equal(all.sampleCount,3)
  for(const forbidden of ['sourceHeader','sourceDigest','processor-1','fieldDefinitions','完整说明','matchedNodeIds'])
    assert.ok(!JSON.stringify(all).includes(forbidden),forbidden)
  assert.equal(h.fake.writeCalls.length,0)
  await assert.rejects(h.repository.getAnalysis({actor:staff,range:{...h.range,businessLineId:'line-1'}}),{code:'FORBIDDEN'})
})
test('old worker snapshots supply verified schema without reading nonselect feedback',async()=>{
  const reads=[],h=analysisHarness({transformRead:({collection,data})=>{reads.push(collection);return data}})
  assert.equal(typeof h.repository.getAnalysis,'function')
  for(const s of h.sources) h.fake.replace('operations_field_snapshots',s.node._id,{_id:s.node._id,...domain.selectionSnapshot(domain.buildFinalFieldResult(s))})
  reads.length=0
  const result=await h.repository.getAnalysis({actor:admin,range:h.range})
  assert.equal(result.sampleCount,3);assert.equal(reads.includes('node_feedback'),false);assert.equal(h.fake.writeCalls.length,0)
})
test('fresh source transaction rejects changed definitions and account revocation',async()=>{
  for(const change of ['definition','disabled','role']) {
    const h=analysisHarness();assert.equal(typeof h.repository.getAnalysis,'function')
    for(const s of h.sources) h.fake.replace('operations_field_snapshots',s.node._id,{_id:s.node._id,...domain.selectionSnapshot(domain.buildFinalFieldResult(s))})
    h.fake.beforeNextTransaction(()=>{
      if(change==='definition') {const n=structuredClone(h.sources[0].node);n.fieldDefinitions[0].constraints.options.push('C');h.fake.replace('business_nodes',n._id,n)}
      else h.fake.replace('users','root',{...admin,...(change==='role'?{role:'user'}:{status:'disabled'})})
    })
    await assert.rejects(h.repository.getAnalysis({actor:admin,range:h.range}),{code:change==='definition'?'REPORT_CHANGED':'FORBIDDEN'})
  }
})
test('cursor includes unmatched source records, newly discovered nodes and original filters',async()=>{
  for(const change of ['unmatched','added','query']) {
    const h=analysisHarness();assert.equal(typeof h.repository.getAnalysis,'function')
    const choice=h.records[0].schema.dimensions[0].id
    const range={...h.range,pageSize:1,analysis:selection(h.records,'field',['tags'],{filters:[{dimensionId:choice,value:'A'}]})}
    const first=await h.repository.getAnalysis({actor:admin,range});assert.equal(first.hasMore,true)
    if(change==='unmatched') {
      const s=h.sources[2],f=structuredClone(s.feedback);f.fieldValues.find(f=>f.fieldKey==='choice').value='A'
      h.fake.replace('node_feedback',f._id,f)
    } else if(change==='added') {
      const s=structuredClone(h.sources[0]);s.node._id='new-node';s.node.latestFeedbackId='new-feedback';s.line.traversedNodeIds.push('new-node')
      s.feedback._id='new-feedback';s.feedback.nodeId='new-node';h.fake.replace('business_lines',s.line._id,s.line)
      h.fake.replace('business_nodes',s.node._id,s.node);h.fake.replace('node_feedback',s.feedback._id,s.feedback)
    } else range.analysis.filters[0].value='B'
    await assert.rejects(h.repository.getAnalysis({actor:admin,range:{...range,cursor:first.nextCursor}}),{code:change==='query'?'VALIDATION_ERROR':'REPORT_CHANGED'})
  }
})
test('changed final header after aggregation cannot release a stale page',async()=>{
  let reads=0
  const h=analysisHarness({transformRead:({collection,data})=>{
    if(collection==='business_nodes' && data && !Array.isArray(data) && data._id==='analysis-node-0' && ++reads===3)
      return {...data,latestFeedbackRevision:77}
    return data
  }})
  assert.equal(typeof h.repository.getAnalysis,'function')
  await assert.rejects(h.repository.getAnalysis({actor:admin,range:h.range}),{code:'REPORT_CHANGED'})
  assert.equal(reads,3)
})
test('source gaps stay visible independently of empty positive charts',async()=>{
  const h=analysisHarness()
  h.fake.replace('business_nodes',h.sources[0].node._id,{...h.sources[0].node,latestFeedbackId:'missing'})
  const result=await h.repository.getAnalysis({actor:staff,range:{...h.range,analysis:selection(h.records,'catalog')}})
  assert.equal(result.incomplete,true);assert.deepEqual(result.items,[])
})
