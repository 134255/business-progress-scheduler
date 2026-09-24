'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { NOW, createCapacityFixture, createProductSource } = require('../fixtures.cjs')
const domain = require('../../../cloudfunctions/businessApi/lib/operations-field-domain')

test('lazy monthly/yearly fixtures have deterministic counts and independent documents', () => {
  for (const [days, lines, nodes] of [[30,900,4500],[180,5400,27000],[365,10950,54750]]) {
    const f = createCapacityFixture({days})
    assert.equal(f.metadata.lineCount, lines)
    assert.equal(f.metadata.completedNodeCount, nodes)
    assert.equal(f.metadata.mediaBytesPerLine, 100000000)
    assert.equal(f.actors.length, 50)
    for (const i of [0, lines-1]) {
      const id = `cap-node-${String(i).padStart(6,'0')}-4`
      const node = f.get('business_nodes', id)
      const line = f.get('business_lines', node.businessLineId)
      const feedback = f.get('node_feedback', node.latestFeedbackId)
      assert.ok(domain.buildFinalFieldResult({line,node,feedback,round:null,votes:[]}))
      assert.ok(line.createdAt < node.completedAt && node.completedAt < NOW)
      assert.equal(line.completedAt.getTime(), node.completedAt.getTime())
      node.name = 'mutation'
      assert.notEqual(f.get('business_nodes', id).name, 'mutation')
    }
    const first = f.entries('business_nodes').next().value
    assert.deepEqual(first, f.get('business_nodes', first._id))
    assert.equal(f.get('business_nodes', 'missing'), undefined)
  }
})
test('empty/invalid inputs and complete collection traversal', () => {
  assert.equal([...createCapacityFixture({linesPerDay:0}).entries('business_nodes')].length,0)
  for(const options of [{days:-1},{days:1.5},{linesPerDay:Infinity},{nodesPerLine:0},{snapshotMode:'other'}])
    assert.throws(()=>createCapacityFixture(options),{code:'INVALID_FIXTURE'})
  const f = createCapacityFixture({days:2,linesPerDay:2})
  for(const [name,count] of [['business_lines',4],['business_nodes',20],['node_feedback',20],['users',50]])
    assert.equal([...f.entries(name)].length,count)
  assert.deepEqual([...f.entries('evidence_files')],[])
})
test('valid and stale snapshots share authoritative final sources', () => {
  const missing=createCapacityFixture(),valid=createCapacityFixture({snapshotMode:'valid'}),stale=createCapacityFixture({snapshotMode:'stale'})
  const id='cap-node-000000-0'
  const a=valid.get('operations_field_snapshots',id),b=stale.get('operations_field_snapshots',id)
  assert.equal(missing.get('operations_field_snapshots',id),undefined)
  assert.notEqual(a.sourceHeader,b.sourceHeader)
  assert.deepEqual({...a,sourceHeader:b.sourceHeader},b)
  assert.deepEqual(valid.get('node_feedback',`feedback-${id}`),stale.get('node_feedback',`feedback-${id}`))
})
test('2495 indexed strict combinations remain an authoritative source, not media bytes', () => {
  const source=createProductSource()
  assert.equal(source.node.fieldDefinitions.length,8)
  assert.equal(source.node.fieldDefinitions[0].optionLinkage.rows.length,2495)
  assert.ok(domain.buildFinalFieldResult(source))
  assert.equal(source.node.fieldDefinitions[0].optionLinkage.rows[2494][7],null)
  assert.ok(!JSON.stringify(source).includes('https://'))
  for(const rowCount of [0,2501,1.5]) assert.throws(()=>createProductSource({rowCount}),{code:'INVALID_FIXTURE'})
})
test('review any/all, old rounds, skipped routes and incompatible definitions keep domain rules', () => {
  const {fieldSource}=require('../../../cloudfunctions/businessApi/test/helpers/field-fixtures')
  for(const reviewMode of ['any','all']) {
    const s=fieldSource({reviewed:true,node:{reviewMode}})
    if(reviewMode==='all') {
      s.votes.push({...s.votes[0],_id:'vote-2',reviewerUserId:'reviewer-2'})
      s.round.approvedVoteCount=2;s.round.voteCount=2
    }
    assert.ok(domain.buildFinalFieldResult(s))
    s.feedback.processingRoundNumber=0
    assert.throws(()=>domain.buildFinalFieldResult(s),{code:'FIELD_SOURCE_INVALID'})
  }
  const s=fieldSource();s.line.traversedNodeIds=[]
  assert.equal(domain.buildFinalFieldResult(s),null)
  const a=fieldSource(),b=fieldSource()
  b.node.fieldDefinitions[0].constraints.options.push('C')
  assert.notEqual(domain.buildFinalFieldResult(a).fields[0].compatibilityKey,domain.buildFinalFieldResult(b).fields[0].compatibilityKey)
})
