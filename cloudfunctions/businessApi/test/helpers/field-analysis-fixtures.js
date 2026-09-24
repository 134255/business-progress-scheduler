'use strict'
const domain = require('../../lib/operations-field-domain')
const { fieldSource } = require('./field-fixtures')
function record(source) {
  const result = domain.buildFinalFieldResult(source)
  return { source, result, schema: domain.describeFieldAnalysisSource(source, result) }
}
function analysisRecords() {
  return [['A', ['X','Y']], ['A', ['Y']], ['B', []]].map(([choice,tags],i) =>
    record(fieldSource({nodeId:`analysis-node-${i}`,values:[{fieldKey:'choice',value:choice},{fieldKey:'tags',value:tags}]})))
}
function productRecords() {
  const options = [['椅类','桌类'],['品牌甲','品牌乙'],['型号一'],['黑','白'],['未用'],['带头枕'],['未用'],['未用']]
  const fieldKeys = ['category','brand','model','color','gap','headrest','unused1','unused2']
  const definitions = options.map((list,i) => ({fieldKey:fieldKeys[i],name:fieldKeys[i],type:'single_select',sequence:i,
    constraints:{options:list},required:false,...(i ? {} : {optionLinkage:{schemaVersion:1,fieldKeys,
      rows:[[0,0,0,0,null,0,null,null],[1,1,0,1,null,null,null,null]]}})}))
  return [0,0,1].map((which,i) => record(fieldSource({nodeId:`product-${i}`,node:{fieldDefinitions:definitions},
    values:[{fieldKey:'category',value:options[0][which]},{fieldKey:'brand',value:options[1][which]},
      {fieldKey:'model',value:'型号一'},{fieldKey:'color',value:options[3][which]},
      ...(which ? [] : [{fieldKey:'headrest',value:'带头枕'}])]})))
}
function selection(records,view,keys=[],extra={}) {
  return {view,nodeGroupId:view==='catalog'?'':records[0].schema.nodeGroupId,linkageId:'',
    dimensionIds:keys.map(key=>records[0].schema.dimensions.find(d=>d.fieldKey===key).id),filters:[],...extra}
}
module.exports={record,analysisRecords,productRecords,selection}
