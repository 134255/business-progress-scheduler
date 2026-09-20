const test = require('node:test')
const assert = require('node:assert/strict')
const { fieldSource } = require('./helpers/field-fixtures')
const { buildFinalFieldResult, fieldExportRows, selectionSnapshot, aggregateFieldResults } = require('../lib/operations-field-domain')
const { summarizeNodeFields } = require('../lib/business-card-summary')

function linkedSource(count = 3) {
  const source = fieldSource()
  source.node.fieldDefinitions = Array.from({ length:8 }, (_, index) => ({
    fieldKey:`f${index}`, sequence:index, name:`字段${index}`, type:'single_select', required:true,
    constraints:{ options:index === 2 ? Array.from({ length:count }, (_, model) => `型号${model}`) : ['A','B'] }
  }))
  source.node.fieldDefinitions[0].optionLinkage = { schemaVersion:1,
    fieldKeys:source.node.fieldDefinitions.map(field => field.fieldKey),
    rows:Array.from({ length:count }, (_, model) => [0,0,model,0,0,null,null,null]) }
  source.feedback.fieldValues = source.node.fieldDefinitions.slice(0, 5).map(field => ({
    fieldKey:field.fieldKey, name:field.name, type:field.type, value:field.constraints.options[0]
  }))
  return source
}

test('statistics count linked selections with only prefix-valid options and CSV includes chosen fields only', () => {
  const result = buildFinalFieldResult(linkedSource())
  assert.deepEqual(result.fields.find(field => field.fieldKey === 'f3').options, ['A'])
  const csv = fieldExportRows([result])
  assert.ok(csv.some(row => row.fieldKey === 'f2' && row.fieldValue === '型号0'))
  assert.ok(csv.every(row => !['f5','f6','f7'].includes(row.fieldKey)))
  assert.equal(JSON.stringify(csv).includes('optionLinkage'), false)
})

test('changing any matrix member semantics splits compatibility groups for every member', () => {
  const source = linkedSource()
  source.node.fieldDefinitions[0].optionLinkage.rows.forEach(row => { row[5] = 0; row[6] = 0; row[7] = 0 })
  source.feedback.fieldValues = source.node.fieldDefinitions.map(field => ({
    fieldKey:field.fieldKey, name:field.name, type:field.type, value:field.constraints.options[0]
  }))
  const first = buildFinalFieldResult(source)
  assert.equal(first.fields.length, 8)
  source.node.fieldDefinitions[0].optionLinkage.rows[1][4] = 1
  const second = buildFinalFieldResult(source)
  first.fields.forEach((field, index) => assert.notEqual(field.compatibilityKey, second.fields[index].compatibilityKey))
})

for (const kind of ['dictionary', 'row', 'both']) {
  test(`equivalent ${kind} reorder retains every linked statistics compatibility key`, () => {
    const source = linkedSource()
    const first = buildFinalFieldResult(source)
    source.line.sourceTemplateVersion++
    source.node._id = 'node-reordered'
    source.line.traversedNodeIds = [source.node._id]
    source.feedback.nodeId = source.node._id
    if (kind !== 'row') source.node.fieldDefinitions.forEach((field, column) => {
      field.constraints.options.reverse()
      source.node.fieldDefinitions[0].optionLinkage.rows.forEach(row => {
        if (row[column] !== null) row[column] = field.constraints.options.length - 1 - row[column]
      })
    })
    if (kind !== 'dictionary') source.node.fieldDefinitions[0].optionLinkage.rows.reverse()
    const second = buildFinalFieldResult(source)
    assert.deepEqual(second.fields.map(field => field.compatibilityKey), first.fields.map(field => field.compatibilityKey))
    const groups = aggregateFieldResults([first, second])
    assert.equal(groups.length, 5)
    groups.forEach(group => {
      assert.deepEqual(group.templateVersions, [1, 2])
      assert.equal(group.filledSampleCount, 2)
    })
  })
}

test('legacy no-rule compatibility hashes remain unchanged', () => {
  assert.deepEqual(buildFinalFieldResult(fieldSource()).fields.map(field => field.compatibilityKey), [
    '5b5e0c771d6d4756ce7fe073490ad075a68820e8aeba1a1981c19a3d106afd08',
    '2827da1da1e5eeb8fc00bb2b0ebaa687a91d526fb0a6aacf0c940772cbfe04ef',
    '9188ddfb118c141351343ccd39cbc34b3fe4a2b4508eec8d87dfb4ff851ea98f',
    '130fc56c792de5e87bb3b9198b2c5be299d2a4d591bec4e821fd496351a2649d',
    '87b70d6542ed80cf4e4ca132c36e7a4231cb5c674148cc4b1c01d8e72c678510',
    'c1b6249cd9516e7eb78d7493bee218b77128cc6268ef5bcc2ed48dee83b8504c',
    'd050fc9932a1c17569080b5ff53b757e905939dbae34a368eb094b188dc13612'
  ])
})

test('analytics can read matrices exceeding the unrelated 2000-item general-array guard', () => {
  const result = buildFinalFieldResult(linkedSource(2495))
  assert.equal(result.fields[2].value, '型号0')
  assert.equal(selectionSnapshot(result).fields[2].options.length,2495)
  assert.ok(fieldExportRows([result]).length>2495)
})

test('large linked result options aggregate without relaxing source-record or value limits', () => {
  const result = buildFinalFieldResult(linkedSource(2495))
  const model = aggregateFieldResults([result]).find(group => group.fieldKey === 'f2')
  assert.equal(model.options.length, 2495)
  assert.equal(model.filledSampleCount, 1)
  assert.equal(model.options.find(option => option.label === '型号0').count, 1)
  assert.equal(model.options.find(option => option.label === '型号2494').count, 0)
  for (const consume of [aggregateFieldResults, fieldExportRows]) {
    assert.throws(() => consume(Array(2001).fill(result)), { code:'FIELD_SOURCE_INVALID' })
  }
  const malformed = structuredClone(result)
  malformed.fields[2].type = 'multi_select'
  malformed.fields[2].value = malformed.fields[2].options.slice(0, 2001)
  assert.throws(() => selectionSnapshot(malformed), { code:'FIELD_SOURCE_INVALID' })
  const oversized = structuredClone(result)
  oversized.fields[2].options = Array.from({ length:5001 }, (_, index) => `型号${index}`)
  assert.throws(() => selectionSnapshot(oversized), { code:'FIELD_SOURCE_INVALID' })
})

test('configured cards support large linked definitions without rendering hidden attrs or matrix data', () => {
  const source = linkedSource(2495)
  const summary=summarizeNodeFields({definitions:source.node.fieldDefinitions,values:source.feedback.fieldValues,
    selections:[{id:'a',fieldKey:'f2'},{id:'b',fieldKey:'f5'}]})
  assert.deepEqual(summary,[{id:'a',label:'字段2',value:'型号0'}])
})
