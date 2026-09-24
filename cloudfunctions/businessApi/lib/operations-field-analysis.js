'use strict'
const crypto = require('node:crypto')
const domain = require('./operations-field-domain')
const HEX = /^[a-f0-9]{64}$/
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(code='FIELD_SOURCE_INVALID') { const error=new Error(code);error.code=code;throw error }
function demand(condition,code) { if(!condition) fail(code) }
function dataCopy(value, depth=0) {
  demand(depth<15)
  if(value===null || ['string','number','boolean'].includes(typeof value)) return value
  const array=Array.isArray(value)
  demand(value && (array ? Object.getPrototypeOf(value)===Array.prototype && Reflect.ownKeys(value).length===value.length+1 :
    [Object.prototype,null].includes(Object.getPrototypeOf(value))))
  const out=array?[]:{}
  for(const key of Reflect.ownKeys(value)) {
    if(array && key==='length') continue
    demand(typeof key==='string' && !['__proto__','constructor','prototype'].includes(key))
    const d=Object.getOwnPropertyDescriptor(value,key);demand(d && Object.hasOwn(d,'value'))
    out[key]=dataCopy(d.value,depth+1)
  }
  return out
}
function verifiedRecords(input) {
  demand(Array.isArray(input) && input.length<=2000 && Object.getPrototypeOf(input)===Array.prototype &&
    Reflect.ownKeys(input).length===input.length+1)
  const seen=new Map()
  for(let i=0;i<input.length;i++) {
    const descriptor=Object.getOwnPropertyDescriptor(input,String(i));demand(descriptor && Object.hasOwn(descriptor,'value'))
    const raw=descriptor.value
    demand(raw && Object.hasOwn(Object.getOwnPropertyDescriptor(raw,'result')||{},'value') &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(raw,'schema')||{},'value'))
    const result=domain.selectionSnapshot(raw.result),schema=dataCopy(raw.schema)
    demand(schema.nodeId===result.nodeId && schema.sourceHeader===result.sourceHeader &&
      schema.sourceDigest===result.sourceDigest && HEX.test(schema.nodeGroupId) && Array.isArray(schema.dimensions) && Array.isArray(schema.linkages))
    const ids=new Set(),keys=new Set(),fields=new Map(result.fields.map(f=>[f.fieldKey,f]))
    for(const d of schema.dimensions) {
      demand(HEX.test(d.id) && HEX.test(d.fieldGroupId) && !ids.has(d.id) && !keys.has(d.fieldKey) &&
        typeof d.name==='string' && d.name.trim() && ['single_select','multi_select'].includes(d.type) &&
        Number.isSafeInteger(d.sequence) && d.sequence>=0 && typeof d.applicable==='boolean')
      ids.add(d.id);keys.add(d.fieldKey)
      const f=fields.get(d.fieldKey)
      demand(d.applicable===Boolean(f) && (!f || f.compatibilityKey===d.fieldGroupId && f.type===d.type))
      if(f && Array.isArray(f.value)) demand(new Set(f.value).size===f.value.length)
    }
    demand(fields.size===schema.dimensions.filter(d=>d.applicable).length)
    const links=new Set()
    for(const l of schema.linkages) {
      demand(HEX.test(l.id) && !links.has(l.id) && Array.isArray(l.dimensionIds) && l.dimensionIds.length===8 &&
        new Set(l.dimensionIds).size===8 && l.dimensionIds.every(id=>ids.has(id)))
      links.add(l.id)
    }
    const copy={result,schema},previous=seen.get(result.nodeId)
    if(previous) demand(JSON.stringify(previous)===JSON.stringify(copy))
    else seen.set(result.nodeId,copy)
  }
  return [...seen.values()].sort((a,b)=>compare(a.result.templateId,b.result.templateId) ||
    a.result.nodeSequence-b.result.nodeSequence || compare(a.result.stableNodeId,b.result.stableNodeId) ||
    a.result.templateVersion-b.result.templateVersion || compare(a.result.completedAt,b.result.completedAt) || compare(a.result.nodeId,b.result.nodeId))
}
function values(record,id) {
  const d=record.schema.dimensions.find(d=>d.id===id)
  if(!d || !d.applicable) return null
  const f=record.result.fields.find(f=>f.fieldKey===d.fieldKey)
  return f.value===null || f.value==='' ? [] : Array.isArray(f.value) ? f.value : [f.value]
}
function metadata(records) {
  const dims=new Map(),links=new Map()
  for(const {result,schema} of records) {
    for(const d of schema.dimensions) {
      if(!dims.has(d.id)) dims.set(d.id,{id:d.id,fieldGroupId:d.fieldGroupId,fieldKey:d.fieldKey,name:d.name,type:d.type,
        sequence:d.sequence,templateName:result.templateName,nodeName:result.nodeName,templateVersions:[]})
      const meta=dims.get(d.id)
      demand(meta.fieldKey===d.fieldKey && meta.type===d.type && meta.fieldGroupId===d.fieldGroupId)
      if(!meta.templateVersions.includes(result.templateVersion)) meta.templateVersions.push(result.templateVersion)
    }
    for(const l of schema.linkages) {
      if(!links.has(l.id)) links.set(l.id,{...l,templateVersions:[]})
      const meta=links.get(l.id)
      demand(JSON.stringify(meta.dimensionIds)===JSON.stringify(l.dimensionIds))
      if(!meta.templateVersions.includes(result.templateVersion)) meta.templateVersions.push(result.templateVersion)
    }
  }
  return {dimensions:[...dims.values()],linkages:[...links.values()]}
}
function counts(records,ids,pair=false) {
  const map=new Map();let filledSampleCount=0,emptySampleCount=0,notApplicableSampleCount=0,used=0
  for(const r of records) {
    if(!ids.every(id=>r.schema.dimensions.some(d=>d.id===id))) continue
    const selected=ids.map(id=>values(r,id))
    if(selected.some(v=>v===null)) {notApplicableSampleCount++;continue}
    if(selected.some(v=>v.length===0)) {emptySampleCount++;continue}
    if(!ids.length) continue
    filledSampleCount++
    const contribution=pair ? selected[0].length*selected[1].length : ids.length===1 ? selected[0].length : 1
    demand(Number.isSafeInteger(contribution) && used+contribution<=50000,'RANGE_TOO_LARGE');used+=contribution
    const add=tuple=>{const key=JSON.stringify(tuple),previous=map.get(key);map.set(key,{values:tuple,count:(previous?previous.count:0)+1})}
    if(pair) for(const a of selected[0]) for(const b of selected[1]) add([a,b])
    else if(ids.length===1) for(const value of selected[0]) add([value])
    else { demand(selected.every(v=>v.length===1));add(selected.map(v=>v[0])) }
  }
  return {items:[...map.values()].sort((a,b)=>b.count-a.count || compare(JSON.stringify(a.values),JSON.stringify(b.values))),
    filledSampleCount,emptySampleCount,notApplicableSampleCount}
}
function bundles(records,dimensions) {
  return dimensions.map(d=>{
    const count=counts(records,[d.id])
    return {...d,...count,items:undefined,options:count.items.slice(0,10).map(i=>({label:i.values[0],count:i.count})),totalOptionCount:count.items.length}
  }).filter(d=>d.totalOptionCount>0).map(({items,...rest})=>rest)
}
function buildFieldAnalysis(input,analysis) {
  const all=verifiedRecords(input),context=dataCopy(analysis)
  demand(['catalog','node','field','product','combinations','pair'].includes(context.view),'VALIDATION_ERROR')
  let records=context.view==='catalog'?all:all.filter(r=>r.schema.nodeGroupId===context.nodeGroupId)
  const meta=metadata(records),byId=new Map(meta.dimensions.map(d=>[d.id,d]))
  demand(context.view==='catalog' || records.length>0,'VALIDATION_ERROR')
  for(const f of context.filters) demand(byId.has(f.dimensionId),'VALIDATION_ERROR')
  for(const id of context.dimensionIds) demand(byId.has(id),'VALIDATION_ERROR')
  let link
  if(['product','combinations'].includes(context.view)) {
    link=meta.linkages.find(l=>l.id===context.linkageId);demand(link,'VALIDATION_ERROR')
    demand(context.filters.length<=8 && context.filters.every((f,i)=>
      link.dimensionIds.includes(f.dimensionId) && (i>=3 || f.dimensionId===link.dimensionIds[i])),'VALIDATION_ERROR')
    demand(context.view!=='combinations' || context.filters.length>=3,'VALIDATION_ERROR')
    records=records.filter(r=>r.schema.linkages.some(l=>l.id===link.id))
  }
  records=records.filter(r=>context.filters.every(f=>(values(r,f.dimensionId)||[]).includes(f.value)))
  const output={view:context.view,matchedNodeIds:records.map(r=>r.result.nodeId),items:[],sampleCount:records.length,
    filledSampleCount:0,emptySampleCount:0,notApplicableSampleCount:0,dimensionMetadata:meta.dimensions,
    linkages:meta.linkages,productStage:'none',context}
  if(context.view==='catalog') {
    const groups=new Map()
    for(const r of records) {const group=groups.get(r.schema.nodeGroupId)||[];group.push(r);groups.set(r.schema.nodeGroupId,group)}
    output.dimensionMetadata=[];output.linkages=[]
    for(const [id,group] of groups) {
      const m=metadata(group),fields=bundles(group,m.dimensions),first=group[0].result
      if(fields.length) output.items.push({id,templateName:first.templateName,nodeName:first.nodeName,
        templateVersions:[...new Set(group.map(r=>r.result.templateVersion))].sort((a,b)=>a-b),sampleCount:group.length,fieldCount:fields.length})
    }
  } else if(context.view==='node') output.items=bundles(records,meta.dimensions)
  else if(context.view==='field' || context.view==='pair') {
    demand(context.dimensionIds.length===(context.view==='pair'?2:1) && new Set(context.dimensionIds).size===context.dimensionIds.length,'VALIDATION_ERROR')
    demand(all.some(r=>r.schema.nodeGroupId===context.nodeGroupId && context.dimensionIds.every(id=>r.schema.dimensions.some(d=>d.id===id))),'VALIDATION_ERROR')
    output.dimensionMetadata=context.dimensionIds.map(id=>byId.get(id))
    Object.assign(output,counts(records,context.dimensionIds,context.view==='pair'))
  } else {
    const nextIndex=Math.min(context.filters.length,3)
    if(nextIndex<3) {
      output.productStage='next';const id=link.dimensionIds[nextIndex]
      output.dimensionMetadata=[byId.get(id)];Object.assign(output,counts(records,[id]))
    } else {
      const ids=link.dimensionIds.slice(3).filter(id=>records.some(r=>values(r,id)!==null))
      output.dimensionMetadata=ids.map(id=>byId.get(id))
      if(context.view==='product') {
        output.productStage=ids.length?'attributes':'none';output.items=bundles(records,output.dimensionMetadata)
      } else Object.assign(output,counts(records,ids))
    }
  }
  return output
}
function fieldAnalysisExportRows(records,analysis) {
  const result=buildFieldAnalysis(records,analysis),ids=new Set(result.matchedNodeIds)
  const selected=[...new Map(records.filter(r=>ids.has(r.result.nodeId)).map(r=>[r.result.nodeId,r])).values()],analysisContextJson=JSON.stringify(result.context)
  const rows=selected.flatMap(record=>domain.fieldExportRows([record.result])
    .filter(r=>r.recordType==='字段明细')
    .map(r=>({...r,analysisGroupId:(record.schema.dimensions.find(d=>d.fieldKey===r.fieldKey)||{}).id||'',analysisContextJson})))
  // The legacy compatibility key intentionally has its old semantics. V2 uses
  // the stricter dimension identity for counting, while retaining that key in
  // the old column. This prevents ancestor changes merging distinct charts.
  for(const d of metadata(verifiedRecords(selected)).dimensions) {
    const count=counts(selected,[d.id])
    for(const item of count.items) rows.push({recordType:'选项统计',dateBasis:'节点完成日期',
      templateName:d.templateName,templateVersions:d.templateVersions.join(','),nodeName:d.nodeName,
      fieldKey:d.fieldKey,fieldName:d.name,fieldType:d.type,fieldGroupId:d.fieldGroupId,analysisGroupId:d.id,
      optionValue:item.values[0],occurrenceCount:item.count,filledSampleCount:count.filledSampleCount,
      emptySampleCount:count.emptySampleCount,notApplicableSampleCount:count.notApplicableSampleCount,
      dataStatus:'有效',analysisContextJson})
  }
  if(['pair','combinations'].includes(result.view) && result.dimensionMetadata.length) {
    const dimensions=result.dimensionMetadata,first=dimensions[0]
    const compatible=selected.filter(r=>dimensions.every(d=>r.schema.dimensions.some(candidate=>candidate.id===d.id)))
    const versions=[...new Set(compatible.map(r=>r.result.templateVersion))].sort((a,b)=>a-b)
    const dimensionIdsJson=JSON.stringify(dimensions.map(d=>d.id)),dimensionNamesJson=JSON.stringify(dimensions.map(d=>d.name))
    const analysisGroupId=hash([analysis.nodeGroupId,dimensions.map(d=>d.id),result.context])
    for(const item of result.items) rows.push({recordType:'关联统计',dateBasis:'节点完成日期',templateName:first.templateName,
      templateVersions:versions.join(','),nodeName:first.nodeName,analysisGroupId,dimensionIdsJson,dimensionNamesJson,
      dimensionValuesJson:JSON.stringify(item.values),occurrenceCount:item.count,filledSampleCount:result.filledSampleCount,
      emptySampleCount:result.emptySampleCount,notApplicableSampleCount:result.notApplicableSampleCount,
      analysisContextJson,dataStatus:'有效'})
  }
  return {matchedNodeIds:result.matchedNodeIds,rows,context:result.context}
}
module.exports={buildFieldAnalysis,fieldAnalysisExportRows}
