const test = require('node:test')
const assert = require('node:assert/strict')
const { createTemplateHarness } = require('./helpers/template-harness')
const { normalizeTemplateNode, normalizeVersion2TemplateDefinition } = require('../lib/template-domain')
const { copyTemplateDefinition } = require('../lib/template-copy-domain')

function input() {
  const fields = Array.from({length:8},(_, index)=>({clientFieldKey:`new${index}`,fieldKey:`f${index}`,sequence:index,
    name:`字段${index}`,type:'single_select',required:true,constraints:{options:['A','B']}}))
  fields[0].optionLinkage = {schemaVersion:1,fieldKeys:fields.map(field=>field.fieldKey),rows:[[0,0,0,0,null,null,null,null]]}
  return {name:'示例',optionLinkageEdit:{schemaVersion:1,expectedDefinitionDigest:null},nodes:[{
    nodeKey:'n',name:'收集',sequence:0,workflowMode:'review',processorUserIds:['p'],reviewerUserIds:[],fields
  }]}
}
const harness = () => createTemplateHarness({users:[{_id:'p',status:'active'}]})

test('create assigns field keys and remaps matrix references', async () => {
  const h = harness(), draft = input()
  const saved = await h.service.createTemplate({actor:h.admin,input:draft})
  assert.deepEqual(saved.nodes[0].fields[0].optionLinkage.fieldKeys,saved.nodes[0].fields.map(field=>field.fieldKey))
  assert.ok(saved.nodes[0].fields.every(field=>!Object.hasOwn(field,'clientFieldKey')))
})
test('update remaps newly allocated field references and refuses unaware or stale client rule loss', async () => {
  const h = harness()
  const draft = input(); draft.nodes[0].fields=[]; delete draft.optionLinkageEdit
  const saved = await h.service.createTemplate({actor:h.admin,input:draft})
  const next = input()
  next.nodes[0].nodeKey=saved.nodes[0].nodeKey
  next.nodes[0].fields.forEach(field=>{delete field.fieldKey})
  next.nodes[0].fields[0].optionLinkage.fieldKeys=next.nodes[0].fields.map(field=>field.clientFieldKey)
  next.optionLinkageEdit.expectedDefinitionDigest=saved.template.definitionDigest
  const updated = await h.service.updateTemplate({actor:h.admin,templateId:saved.template._id,expectedVersion:1,input:next})
  assert.deepEqual(updated.nodes[0].fields[0].optionLinkage.fieldKeys,updated.nodes[0].fields.map(field=>field.fieldKey))
  const stripped={name:'示例',nodes:structuredClone(updated.nodes)}
  delete stripped.nodes[0].fields[0].optionLinkage
  await assert.rejects(h.service.updateTemplate({actor:h.admin,templateId:saved.template._id,expectedVersion:2,input:stripped}),{code:'TEMPLATE_INVALID'})
  stripped.optionLinkageEdit={schemaVersion:1,expectedDefinitionDigest:saved.template.definitionDigest}
  await assert.rejects(h.service.updateTemplate({actor:h.admin,templateId:saved.template._id,expectedVersion:2,input:stripped}),{code:'VERSION_CONFLICT'})
})
test('copy remaps every linkage member without changing combinations', () => {
  const draft=input(); let serial=0
  const result=copyTemplateDefinition({template:{},nodes:draft.nodes},prefix=>`${prefix}-copy-${++serial}`)
  assert.deepEqual(result.nodes[0].fields[0].optionLinkage.fieldKeys,result.nodes[0].fields.map(field=>field.fieldKey))
  assert.deepEqual(result.nodes[0].fields[0].optionLinkage.rows,draft.nodes[0].fields[0].optionLinkage.rows)
})
test('linked node budget and routing-control exclusion enforced without restricting legacy nodes', () => {
  const draft=input(), node=draft.nodes[0]
  node.description='字'.repeat(180000)
  assert.throws(()=>normalizeTemplateNode(node),{code:'TEMPLATE_INVALID'})
  delete node.fields[0].optionLinkage
  assert.doesNotThrow(()=>normalizeTemplateNode(node))
  for (const key of ['f0','f3']) {
    const linked=input().nodes[0]
    linked.next={mode:'single_select',fieldKey:key,optionTargets:{A:'end',B:'end'}}
    assert.throws(()=>normalizeVersion2TemplateDefinition({flowSchemaVersion:2,entryNodeKey:'n',nodes:[linked]}))
  }
})

test('v2 byte budget covers the final routed node at the exact boundary, not only its base projection', () => {
  const node = input().nodes[0]
  node.next = { mode:'end' }
  const definition = { flowSchemaVersion:2, entryNodeKey:'n', nodes:[node] }
  const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
  const initialFinal = normalizeVersion2TemplateDefinition(definition).nodes[0]
  const limit = 512 * 1024
  node.description = 'x'.repeat(limit - bytes(initialFinal))
  const atLimit = normalizeVersion2TemplateDefinition(definition).nodes[0]
  assert.equal(bytes(atLimit), limit)
  assert.deepEqual(atLimit.next, { mode:'end' })
  assert.equal(atLimit.includeBusinessCreatorAsProcessor, false)
  assert.ok(bytes(normalizeTemplateNode(node)) < limit)

  node.description += 'x'
  assert.ok(bytes(normalizeTemplateNode(node)) < limit, 'base still fits; the completed routed node exceeds the limit by one byte')
  assert.throws(() => normalizeVersion2TemplateDefinition(definition), { code:'TEMPLATE_INVALID' })

  delete node.fields[0].optionLinkage
  node.description = 'x'.repeat(limit + 1)
  assert.ok(bytes(normalizeVersion2TemplateDefinition(definition).nodes[0]) > limit)
})
