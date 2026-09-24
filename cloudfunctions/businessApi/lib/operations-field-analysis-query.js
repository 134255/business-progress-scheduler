const {normalizeFieldQuery,fieldError}=require('./operations-field-query')
const HEX=/^[a-f0-9]{64}$/
function demand(value) { if(!value) throw fieldError('VALIDATION_ERROR') }
function object(input,keys) {
  demand(input && typeof input==='object' && !Array.isArray(input) && [Object.prototype,null].includes(Object.getPrototypeOf(input)))
  const out={}
  for(const key of Reflect.ownKeys(input)) {
    demand(typeof key==='string' && !['__proto__','constructor','prototype'].includes(key) && (!keys || keys.includes(key)))
    const d=Object.getOwnPropertyDescriptor(input,key);demand(d && Object.hasOwn(d,'value'));out[key]=d.value
  }
  return out
}
function array(input,max) {
  demand(Array.isArray(input) && Object.getPrototypeOf(input)===Array.prototype && input.length<=max && Reflect.ownKeys(input).length===input.length+1)
  return Array.from({length:input.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(input,String(i));demand(d && Object.hasOwn(d,'value'));return d.value})
}
function normalizeAnalysis(input) {
  const a=object(input,['view','nodeGroupId','linkageId','dimensionIds','filters'])
  demand(['catalog','node','field','product','combinations','pair'].includes(a.view))
  const nodeGroupId=a.nodeGroupId===undefined?'':a.nodeGroupId,linkageId=a.linkageId===undefined?'':a.linkageId
  const dimensionIds=array(a.dimensionIds===undefined?[]:a.dimensionIds,2)
  demand(dimensionIds.every(id=>typeof id==='string' && HEX.test(id)) && new Set(dimensionIds).size===dimensionIds.length)
  const filters=array(a.filters===undefined?[]:a.filters,8).map(raw=>{
    const f=object(raw,['dimensionId','value'])
    demand(typeof f.dimensionId==='string' && HEX.test(f.dimensionId) && typeof f.value==='string' && f.value.trim() && f.value.length<=65536)
    return {dimensionId:f.dimensionId,value:f.value}
  })
  demand(new Set(filters.map(f=>f.dimensionId)).size===filters.length)
  demand(a.view==='catalog' ? nodeGroupId==='' && filters.length===0 : typeof nodeGroupId==='string' && HEX.test(nodeGroupId))
  demand(['product','combinations'].includes(a.view) ? typeof linkageId==='string' && HEX.test(linkageId) : linkageId==='')
  demand(dimensionIds.length===(a.view==='pair'?2:a.view==='field'?1:0))
  const result={view:a.view,nodeGroupId,linkageId,dimensionIds,filters}
  demand(Buffer.byteLength(JSON.stringify(result))<=64*1024)
  return result
}
function normalizeAnalysisQuery(query={},now) {
  const {analysis,...legacy}=object(query)
  return {...normalizeFieldQuery(legacy,now),analysis:normalizeAnalysis(analysis)}
}
function normalizeFieldReportQuery(query={},now) {
  const input=object(query)
  if(!Object.hasOwn(input,'reportVersion')) return normalizeFieldQuery(input,now)
  demand(input.reportVersion===2)
  const {reportVersion,...analysisQuery}=input
  return {...normalizeAnalysisQuery(analysisQuery,now),reportVersion}
}
module.exports={normalizeAnalysis,normalizeAnalysisQuery,normalizeFieldReportQuery}
