const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { deriveConditionalForm } = require('../utils/conditional-form')

function fields() {
  const result = Array.from({ length:8 }, (_, index) => ({ fieldKey:`f${index}`, sequence:index,
    type:'single_select', required:true, constraints:{ options:['A','B'] } }))
  result[0].optionLinkage = {schemaVersion:1,fieldKeys:result.map(field=>field.fieldKey),
    rows:[[0,0,0,0,0,null,null,0],[0,0,0,1,1,null,null,1],[1,1,1,null,0,null,null,null]]}
  return result
}
test('client shares identical validated rule engine with backend', () => {
  assert.equal(readFileSync(require.resolve('../utils/option-linkage-domain'),'utf8'),
    readFileSync(require.resolve('../../cloudfunctions/businessApi/lib/option-linkage-domain'),'utf8'))
})
test('form only renders current prefix choices and no matrix', () => {
  const result = deriveConditionalForm(fields(),{f0:'A',f1:'A',f2:'A',f3:'A'})
  assert.deepEqual(result.visibleFields.map(field=>field.fieldKey),['f0','f1','f2','f3','f4'])
  assert.deepEqual(result.visibleFields.at(-1).constraints.options,['A'])
  assert.equal(JSON.stringify(result.visibleFields).includes('optionLinkage'),false)
})
test('new category removes incompatible descendants but keeps unrelated values', () => {
  const definitions = fields().concat({fieldKey:'note',sequence:8,type:'short_text',constraints:{}})
  const result = deriveConditionalForm(definitions,{f0:'B',f1:'A',f2:'A',f3:'A',f4:'A',f7:'A',note:'保留'})
  assert.equal(result.fieldValues.note,'保留')
  assert.equal(result.fieldValues.f0,'B')
  assert.deepEqual(result.clearedFieldKeys,['f1','f2','f3','f4','f7'])
  assert.deepEqual(result.visibleFields.map(field=>field.fieldKey),['f0','f1','note'])
})
