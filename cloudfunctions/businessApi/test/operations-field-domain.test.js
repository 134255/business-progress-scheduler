'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { fieldSource } = require('./helpers/field-fixtures')
const domain = require('../lib/operations-field-domain')
const { personFilterToken } = require('../../operationsAnalytics/lib/analytics-domain')

function invalid(source) {
  assert.throws(() => domain.buildFinalFieldResult(source), { code: 'FIELD_SOURCE_INVALID' })
}

test('published complete_node snapshots preserve all seven types, zero and false on the Shanghai completion day', () => {
  const result = domain.buildFinalFieldResult(fieldSource())
  assert.ok(result, 'a proven completed result must not be discarded')
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.day, '2026-09-11')
  assert.equal(result.completedAt, '2026-09-10T16:30:00.000Z')
  assert.equal(result.templateId, 'template-1')
  assert.equal(result.templateName, '', 'production lines do not store a template name')
  assert.equal(result.stableNodeId, 'stable-node-1')
  assert.deepEqual(result.fields.map(field => [field.fieldKey, field.value]), [
    ['choice', 'A'], ['tags', ['X', 'Y']], ['amount', 0], ['confirmed', false],
    ['short-note', '简短说明'], ['note', '完整说明'], ['date', '2026-09-10']
  ])
})

test('selection snapshots retain only choices and cannot mutate the full result', () => {
  const result = domain.buildFinalFieldResult(fieldSource())
  const snapshot = domain.selectionSnapshot(result)
  assert.deepEqual(snapshot.fields.map(field => field.type), ['single_select', 'multi_select'])
  assert.equal(snapshot.sourceDigest, result.sourceDigest)
  assert.equal(snapshot.sourceHeader, result.sourceHeader)
  snapshot.fields[1].value.push('Z')
  assert.deepEqual(result.fields[1].value, ['X', 'Y'])
})

test('duplicate sources count once, multiselect counts each choice and unselected options stay zero', () => {
  const result = domain.buildFinalFieldResult(fieldSource())
  const groups = domain.aggregateFieldResults([result, structuredClone(result)])
  assert.equal(groups.length, 2)
  const choice = groups.find(group => group.fieldKey === 'choice')
  assert.equal(choice.filledSampleCount, 1)
  assert.equal(choice.emptySampleCount, 0)
  assert.deepEqual(choice.options, [{ label: 'A', count: 1 }, { label: 'B', count: 0 }])
  assert.deepEqual(groups.find(group => group.fieldKey === 'tags').options,
    [{ label: 'X', count: 1 }, { label: 'Y', count: 1 }, { label: 'Z', count: 0 }])
})

test('final approved round attributes the submitter and actual approving voters, not candidates or the earlier saver', () => {
  const source = fieldSource({ reviewed: true, node: { processingRoundNumber: 3, reviewRoundNumber: 3 } })
  const result = domain.buildFinalFieldResult(source)
  assert.ok(result)
  assert.equal(result.processorToken, personFilterToken('processor', 'processor-2'))
  assert.deepEqual(result.reviewerTokens, [personFilterToken('reviewer', 'reviewer-1')])
  assert.equal(result.fields[0].value, 'A')
  const direct = domain.buildFinalFieldResult(fieldSource())
  assert.equal(direct.processorToken, personFilterToken('processor', 'processor-1'))
  assert.deepEqual(direct.reviewerTokens, [])
})

test('ALL approval requires each frozen reviewer vote and counts the node only once', () => {
  const source = fieldSource({ reviewed: true, node: { reviewMode: 'all' } })
  source.round.approvedVoteCount = 2
  source.round.voteCount = 2
  source.votes.push({ ...source.votes[0], _id: 'vote-second', reviewerUserId: 'reviewer-2' })
  const result = domain.buildFinalFieldResult(source)
  assert.equal(result.reviewerTokens.length, 2)
  assert.equal(domain.aggregateFieldResults([result])[0].filledSampleCount, 1)
  source.votes.pop()
  invalid(source)
})

for (const [label, change] of [
  ['unfinished', source => { source.node.status = 'in_progress'; source.node.routeState = 'active' }],
  ['dormant route', source => { source.node.routeState = 'dormant'; source.line.traversedNodeIds = [] }],
  ['skipped route', source => { source.node.routeState = 'skipped' }],
  ['not traversed', source => { source.line.traversedNodeIds = [] }],
  ['unstarted optional tail', source => { source.node.status = 'awaiting_decision'; source.node.activationMode = 'optional_tail'; source.node.routeState = 'dormant' }],
  ['deleted business', source => { source.line.status = 'deleted' }],
  ['unpublished business', source => { source.line.status = 'creating' }]
]) {
  test(`${label} does not contribute a final field sample`, () => {
    const source = fieldSource()
    change(source)
    assert.equal(domain.buildFinalFieldResult(source), null)
  })
}

test('completed fields awaiting a manual successor decision count for direct and reviewed nodes', () => {
  for (const reviewed of [false, true]) {
    const source = fieldSource({ reviewed,
      line: { awaitingManualDecision: true, currentNodeId: 'node-1' },
      node: { status: 'awaiting_decision', routeState: 'awaiting_manual_decision' } })
    assert.equal(domain.buildFinalFieldResult(source).fields[0].value, 'A')
  }
})

test('pre-v2 reviewerless review workflow has no fabricated route or review history', () => {
  const source = fieldSource()
  for (const key of ['flowSchemaVersion', 'entryNodeId', 'traversedNodeIds', 'routeDecisionVersion', 'awaitingManualDecision']) delete source.line[key]
  for (const key of ['flowSchemaVersion', 'routeState', 'nodeKey', 'next']) delete source.node[key]
  assert.equal(domain.buildFinalFieldResult(source).fields[0].value, 'A')
})

for (const [label, change] of [
  ['node belongs to another business', source => { source.node.businessLineId = 'other-line' }],
  ['feedback belongs to another node', source => { source.feedback.nodeId = 'other-node' }],
  ['feedback belongs to another business', source => { source.feedback.businessLineId = 'other-line' }],
  ['wrong feedback id', source => { source.feedback._id = 'old-feedback' }],
  ['wrong feedback revision', source => { source.feedback.revision-- }],
  ['unpublished feedback', source => { source.feedback.publishState = 'reserved' }],
  ['old processing round', source => { source.feedback.processingRoundNumber++ }],
  ['save is not a completion', source => { source.feedback.action = 'save_progress' }],
  ['unfinished completion feedback', source => { source.feedback.status = 'in_progress' }],
  ['missing final pointer', source => { delete source.node.latestFeedbackId }],
  ['unknown route state', source => { source.node.routeState = 'invented' }],
  ['active review at completion', source => { source.node.activeReviewRoundId = 'pending-round' }],
  ['invalid completedAt', source => { source.node.completedAt = new Date(NaN) }],
  ['impossible completedAt date', source => { source.node.completedAt = '2026-02-30T12:00:00.000Z' }],
  ['missing completedAt', source => { delete source.node.completedAt }],
  ['missing definitions', source => { delete source.node.fieldDefinitions }],
  ['unknown stored field', source => { source.feedback.fieldValues.push({ fieldKey: 'unknown', name: '未知', type: 'number', value: 1 }) }],
  ['wrong snapshot type', source => { source.feedback.fieldValues[0].type = 'number' }],
  ['unknown select option', source => { source.feedback.fieldValues[0].value = 'not-an-option' }],
  ['duplicate multiselect choice', source => { source.feedback.fieldValues[1].value = ['X', 'X'] }],
  ['duplicate field value', source => { source.feedback.fieldValues.push(source.feedback.fieldValues[0]) }],
  ['duplicate definition', source => { source.node.fieldDefinitions.push(source.node.fieldDefinitions[0]) }],
  ['invalid definition constraints', source => { source.node.fieldDefinitions[2].constraints = { min: 10, max: 1 } }]
]) {
  test(`fails closed for ${label}`, () => { const source = fieldSource(); change(source); invalid(source) })
}

for (const [label, change] of [
  ['missing approved round', source => { source.round = null }],
  ['wrong round pointer', source => { source.round._id = 'old-round' }],
  ['wrong round business', source => { source.round.businessLineId = 'other-line' }],
  ['wrong round node', source => { source.round.nodeId = 'other-node' }],
  ['rejected old round', source => { source.round.status = 'rejected'; source.round.finalDecision = 'rejected' }],
  ['wrong round revision', source => { source.round.feedbackRevision++ }],
  ['wrong processing round', source => { source.round.processingRoundNumber++ }],
  ['wrong review round', source => { source.round.reviewRoundNumber++ }],
  ['round values disagree with feedback', source => { source.round.fieldValues[0].value = 'B' }],
  ['missing actual votes', source => { source.votes = [] }],
  ['vote from old round', source => { source.votes[0].reviewRoundId = 'old-round' }],
  ['vote from different node', source => { source.votes[0].nodeId = 'other-node' }],
  ['unassigned voter', source => { source.votes[0].reviewerUserId = 'outsider' }],
  ['rejected vote', source => { source.votes[0].decision = 'rejected' }],
  ['duplicate voter', source => { source.votes.push({ ...source.votes[0], _id: 'duplicate-vote' }) }],
  ['unassigned submitter', source => { source.round.submittedBy = 'outsider' }]
]) {
  test(`reviewed source fails closed for ${label}`, () => { const source = fieldSource({ reviewed: true }); change(source); invalid(source) })
}

test('rejects inherited keys and accessors without executing them', () => {
  let executed = 0
  for (const change of [
    source => { Object.defineProperty(source.node, 'completedAt', { get() { executed++; return new Date() } }) },
    source => { Object.defineProperty(source.feedback.fieldValues[0], 'value', { get() { executed++; return 'A' } }) },
    source => { Object.defineProperty(source.node.fieldDefinitions[0].constraints.options, '0', { get() { executed++; return 'A' } }) },
    source => { source.node = Object.create(source.node) },
    source => { source.feedback.fieldValues[0] = Object.create(source.feedback.fieldValues[0]) },
    source => { delete source.feedback.fieldValues[1] }
  ]) { const source = fieldSource(); change(source); invalid(source) }
  assert.equal(executed, 0)
})

const conditionalDefinitions = [
  { fieldKey: 'parent-key', name: '父项', type: 'single_select', sequence: 0, constraints: { options: ['A', 'B'] } },
  { fieldKey: 'child-key', name: '子项', type: 'single_select', sequence: 1, constraints: { options: ['X', 'Y'] },
    condition: { parentFieldKey: 'parent-key', visibleWhen: ['A'], optionsByParentValue: { A: ['X'] } } }
]

test('conditional fields use resolved options; hidden fields do not enter either denominator or export', () => {
  const visible = domain.buildFinalFieldResult(fieldSource({ node: { fieldDefinitions: conditionalDefinitions },
    values: [{ fieldKey: 'parent-key', value: 'A' }, { fieldKey: 'child-key', value: 'X' }] }))
  const hidden = domain.buildFinalFieldResult(fieldSource({ nodeId: 'node-2', node: { fieldDefinitions: conditionalDefinitions },
    values: [{ fieldKey: 'parent-key', value: 'B' }] }))
  const group = domain.aggregateFieldResults([visible, hidden]).find(item => item.fieldKey === 'child-key')
  assert.deepEqual(group.options, [{ label: 'X', count: 1 }])
  assert.equal(group.filledSampleCount, 1)
  assert.equal(group.emptySampleCount, 0)
  assert.equal(hidden.fields.length, 1)
  assert.equal(domain.fieldExportRows([hidden]).filter(row => row.fieldKey === 'child-key').length, 0)
})

test('hidden stored values and stale visible cascade choices fail closed', () => {
  const source = fieldSource({ node: { fieldDefinitions: conditionalDefinitions }, values: [{ fieldKey: 'parent-key', value: 'B' }] })
  source.feedback.fieldValues.push({ fieldKey: 'child-key', name: '子项', type: 'single_select', value: 'X' })
  invalid(source)
  source.feedback.fieldValues[0].value = 'A'
  source.feedback.fieldValues[1].value = 'Y'
  invalid(source)
})

test('production null optional single-select snapshots are counted as empty, not invalid or zero-valued selections', () => {
  const result = domain.buildFinalFieldResult(fieldSource({ values: [{ fieldKey: 'tags', value: [] }] }))
  const groups = domain.aggregateFieldResults([result])
  assert.deepEqual(groups.map(group => [group.filledSampleCount, group.emptySampleCount]), [[0, 1], [0, 1]])
  assert.deepEqual(groups[0].options, [{ label: 'A', count: 0 }, { label: 'B', count: 0 }])
  assert.equal(domain.fieldExportRows([result]).find(row => row.fieldKey === 'choice').dataStatus, '未填写')
})

test('compatible template versions merge regardless of label or candidate ordering; changed candidate sets split', () => {
  const first = domain.buildFinalFieldResult(fieldSource())
  const secondSource = fieldSource({ nodeId: 'node-2', line: { sourceTemplateVersion: 2 } })
  secondSource.node.fieldDefinitions[0].constraints.options.reverse()
  secondSource.node.fieldDefinitions[0].name = '新版单选'
  secondSource.feedback.fieldValues[0].name = '新版单选'
  const second = domain.buildFinalFieldResult(secondSource)
  const compatible = domain.aggregateFieldResults([first, second]).filter(group => group.fieldKey === 'choice')
  assert.equal(compatible.length, 1)
  assert.deepEqual(compatible[0].templateVersions, [1, 2])
  assert.equal(compatible[0].options[0].count, 2)
  secondSource.node.fieldDefinitions[0].constraints.options.push('C')
  const changed = domain.buildFinalFieldResult(secondSource)
  assert.equal(domain.aggregateFieldResults([first, changed]).filter(group => group.fieldKey === 'choice').length, 2)
})

test('same names cannot merge different stable identities, types or condition definitions', () => {
  const base = domain.buildFinalFieldResult(fieldSource())
  for (const change of [
    source => { source.line.sourceTemplateId = 'other-template' },
    source => { source.node.sourceTemplateNodeKey = 'other-stable-node' },
    source => { source.node.fieldDefinitions[0].fieldKey = 'other-field'; source.feedback.fieldValues[0].fieldKey = 'other-field' },
    source => { source.node.fieldDefinitions[0].type = 'multi_select'; source.feedback.fieldValues[0].type = 'multi_select'; source.feedback.fieldValues[0].value = ['A'] },
    source => { source.node.fieldDefinitions[1].condition = { parentFieldKey: 'choice', visibleWhen: ['A'] } }
  ]) {
    const source = fieldSource({ nodeId: 'node-2' }); change(source)
    const changed = domain.buildFinalFieldResult(source)
    assert.ok(domain.aggregateFieldResults([base, changed]).length > 2)
  }
})

test('same node with changed source or changed content under a forged unchanged digest is rejected', () => {
  const base = domain.buildFinalFieldResult(fieldSource())
  const source = fieldSource(); source.feedback.fieldValues[0].value = 'B'
  const changed = domain.buildFinalFieldResult(source)
  assert.throws(() => domain.aggregateFieldResults([base, changed]), { code: 'FIELD_SOURCE_INVALID' })
  changed.sourceDigest = base.sourceDigest
  assert.throws(() => domain.aggregateFieldResults([base, changed]), { code: 'FIELD_SOURCE_INVALID' })
  assert.throws(() => domain.fieldExportRows([base, changed]), { code: 'FIELD_SOURCE_INVALID' })
})

test('calendar recomputation and unrelated line progress do not change immutable field source digest', () => {
  const source = fieldSource({ reviewed: true })
  const before = domain.buildFinalFieldResult(source)
  source.node.version += 2; source.round.version += 2; source.line.version++
  source.node.processingElapsedWorkMinutes = 300
  source.round.processingRoundWorkMinutes = 300
  source.round.processingRoundTimingStatus = 'calculated'
  source.round.processingRoundCalendarVersion = 'calendar-later'
  source.votes[0].reviewResponseWorkMinutes = 25
  source.votes[0].reviewResponseTimingStatus = 'calculated'
  source.line.status = 'completed'
  assert.equal(domain.buildFinalFieldResult(source).sourceDigest, before.sourceDigest)
  source.feedback.revision++; source.node.latestFeedbackRevision++; source.round.feedbackRevision++
  assert.notEqual(domain.buildFinalFieldResult(source).sourceDigest, before.sourceDigest)
})

test('source header binds final pointers, definitions, completion and role lineage but ignores calendar versions', () => {
  const source = fieldSource({ reviewed: true })
  assert.equal(typeof domain.fieldSourceHeader, 'function')
  const header = domain.fieldSourceHeader({ line: source.line, node: source.node })
  assert.match(header, /^[a-f0-9]{64}$/)
  assert.equal(domain.buildFinalFieldResult(source).sourceHeader, header)
  source.node.version++; source.line.version++; source.node.processingElapsedWorkMinutes = 44
  source.line.currentNodeId = 'later-node'; source.line.traversedNodeIds.push('next-node')
  assert.equal(domain.fieldSourceHeader(source), header)
  for (const change of [
    item => { item.node.latestFeedbackRevision++ },
    item => { item.node.lastReviewRoundId = 'other-round' },
    item => { item.node.completedAt = new Date('2026-09-11T01:00:00.000Z') },
    item => { item.node.processorUserIds.pop() },
    item => { item.node.fieldDefinitions[0].constraints.options.push('C') },
    item => { item.line.traversedNodeIds = [] },
    item => { item.node.routeState = 'skipped' }
  ]) {
    const changed = structuredClone(source); change(changed)
    assert.notEqual(domain.fieldSourceHeader(changed), header)
  }
})

test('header-only checks reject malformed completed lineage without loading feedback, rounds or votes', () => {
  for (const change of [
    source => { delete source.node.latestFeedbackId },
    source => { source.node.latestFeedbackRevision = 0 },
    source => { delete source.node.lastReviewRoundId },
    source => { source.node.reviewRoundNumber = 0 },
    source => { source.node.fieldDefinitions[1].condition = { parentFieldKey: 'missing-parent', visibleWhen: ['A'] } }
  ]) {
    const source = fieldSource({ reviewed: true }); change(source)
    assert.throws(() => domain.fieldSourceHeader({ line: source.line, node: source.node }), { code: 'FIELD_SOURCE_INVALID' })
  }
})

test('CSV projection preserves complete text, boolean/zero and lossless multiselect boundaries without worktime or identities', () => {
  const source = fieldSource()
  const labels = ['逗号,选项', '引号"选项', '换行\n选项', 'A、B']
  source.node.fieldDefinitions[1].constraints.options = labels
  source.feedback.fieldValues[1].value = labels
  source.feedback.fieldValues[5].value = '=公式前缀,"\n' + '完整内容'.repeat(100)
  const result = domain.buildFinalFieldResult(source)
  const rows = domain.fieldExportRows([result, result])
  const details = rows.filter(row => row.recordType === '字段明细')
  const statistics = rows.filter(row => row.recordType === '选项统计')
  assert.equal(details.length, 7)
  assert.deepEqual(rows.slice(0, 7), details)
  assert.equal(details.find(row => row.fieldKey === 'amount').fieldValue, '0')
  assert.equal(details.find(row => row.fieldKey === 'confirmed').fieldValue, '否')
  assert.equal(details.find(row => row.fieldKey === 'note').fieldValue, '=公式前缀,"\n' + '完整内容'.repeat(100))
  assert.deepEqual(JSON.parse(details.find(row => row.fieldKey === 'tags').fieldValue), labels)
  assert.ok(rows.every(row => row.dateBasis === '节点完成日期'))
  assert.equal(details[0].businessCode, '20260910-0001')
  assert.equal(details[0].nodeCompletedAt, '2026-09-10T16:30:00.000Z')
  assert.ok(statistics.every(row => !Object.hasOwn(row, 'businessCode')))
  for (const row of rows) {
    assert.ok(!Object.keys(row).some(key => /Minutes|processorToken|reviewerTokens|submittedBy|evidence|userId/i.test(key)))
  }
  for (const row of statistics) {
    const matching = details.filter(detail => detail.fieldGroupId === row.fieldGroupId)
    const count = matching.reduce((total, detail) => total + (detail.fieldType === 'multi_select'
      ? JSON.parse(detail.fieldValue).includes(row.optionValue) : detail.fieldValue === row.optionValue), 0)
    assert.equal(row.occurrenceCount, count)
  }
})

test('empty datasets and reversed input order produce deterministic groups and detail-then-summary rows', () => {
  assert.deepEqual(domain.aggregateFieldResults([]), [])
  assert.deepEqual(domain.fieldExportRows([]), [])
  const results = ['node-2', 'node-1'].map(nodeId => domain.buildFinalFieldResult(fieldSource({ nodeId })))
  assert.deepEqual(domain.aggregateFieldResults(results), domain.aggregateFieldResults([...results].reverse()))
  assert.deepEqual(domain.fieldExportRows(results), domain.fieldExportRows([...results].reverse()))
})

test('malformed optional source pointers cannot masquerade as absent pointers', () => {
  for (const key of ['activeReviewRoundId', 'lastReviewRoundId']) for (const value of [false, 0, '', undefined]) {
    const source = fieldSource()
    source.node[key] = value
    invalid(source)
  }
})

test('snapshot projection rejects extra field properties instead of carrying arbitrary content into persisted selections', () => {
  const result = domain.buildFinalFieldResult(fieldSource())
  result.fields[0].unrelatedText = 'must not persist'
  assert.throws(() => domain.selectionSnapshot(result), { code: 'FIELD_SOURCE_INVALID' })
})

test('snapshot consumers reject invalid values and a malformed header digest', () => {
  for (const change of [
    result => { result.fields[0].value = 'not-an-option' },
    result => { result.fields[1].value = ['X', 'X'] },
    result => { result.sourceHeader = 'not-a-digest' },
    result => { Object.setPrototypeOf(result.fields[0], { inherited: true }) }
  ]) {
    const result = domain.buildFinalFieldResult(fieldSource()); change(result)
    assert.throws(() => domain.aggregateFieldResults([result]), { code: 'FIELD_SOURCE_INVALID' })
  }
})

test('two thousand distinct completed-node samples are exact and a larger report is rejected', () => {
  const results = Array.from({ length: 2000 }, (_, index) =>
    domain.buildFinalFieldResult(fieldSource({ nodeId: `node-${index}` })))
  const groups = domain.aggregateFieldResults(results)
  assert.equal(groups[0].filledSampleCount, 2000)
  assert.equal(groups[0].options[0].count, 2000)
  assert.throws(() => domain.aggregateFieldResults([...results, results[0]]), { code: 'FIELD_SOURCE_INVALID' })
})

test('optional select absence does not weaken required field validation', () => {
  const source = fieldSource({ values: [] })
  source.node.fieldDefinitions[0].required = true
  invalid(source)
})

test('compatible conditional groups union only candidates resolved for sampled parent values', () => {
  const definitions = structuredClone(conditionalDefinitions)
  definitions[1].condition = { parentFieldKey: 'parent-key', visibleWhen: ['A', 'B'], optionsByParentValue: { A: ['X'], B: ['Y'] } }
  const left = domain.buildFinalFieldResult(fieldSource({ nodeId: 'left', node: { fieldDefinitions: definitions },
    values: [{ fieldKey: 'parent-key', value: 'A' }, { fieldKey: 'child-key', value: 'X' }] }))
  const right = domain.buildFinalFieldResult(fieldSource({ nodeId: 'right', node: { fieldDefinitions: definitions },
    values: [{ fieldKey: 'parent-key', value: 'B' }, { fieldKey: 'child-key', value: 'Y' }] }))
  const groups = domain.aggregateFieldResults([left, right]).filter(group => group.fieldKey === 'child-key')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].filledSampleCount, 2)
  assert.deepEqual(groups[0].options, [{ label: 'X', count: 1 }, { label: 'Y', count: 1 }])
})
