const {utf8Bytes}=require('./operations-field-report')
const HEX=/^[a-f0-9]{64}$/
const VIEWS=['catalog','node','field','product','combinations','pair']
const catalogSelection=()=>({view:'catalog',nodeGroupId:'',linkageId:'',dimensionIds:[],filters:[]})
function demand(value) {if(!value) throw new Error('INVALID_FIELD_ANALYSIS')}
const count=n=>Number.isSafeInteger(n) && n>=0
const text=s=>typeof s==='string' && s.trim().length>0
const id=s=>typeof s==='string' && HEX.test(s)
function normalizeSelection(raw) {
  demand(raw && typeof raw==='object' && !Array.isArray(raw) && VIEWS.includes(raw.view))
  demand(Object.keys(raw).every(k=>['view','nodeGroupId','linkageId','dimensionIds','filters'].includes(k)))
  demand(raw.view==='catalog'?raw.nodeGroupId==='':id(raw.nodeGroupId))
  demand(['product','combinations'].includes(raw.view)?id(raw.linkageId):raw.linkageId==='')
  demand(Array.isArray(raw.dimensionIds) && raw.dimensionIds.length===(raw.view==='pair'?2:raw.view==='field'?1:0) &&
    raw.dimensionIds.every(id) && new Set(raw.dimensionIds).size===raw.dimensionIds.length)
  demand(Array.isArray(raw.filters) && raw.filters.length<=8 && (raw.view!=='catalog' || raw.filters.length===0))
  const filters=raw.filters.map(f=>{demand(f && id(f.dimensionId) && text(f.value) &&
    Object.keys(f).every(k=>['dimensionId','value'].includes(k)));return {dimensionId:f.dimensionId,value:f.value}})
  demand(new Set(filters.map(f=>f.dimensionId)).size===filters.length)
  return {view:raw.view,nodeGroupId:raw.nodeGroupId,linkageId:raw.linkageId,dimensionIds:raw.dimensionIds.slice(),filters}
}
function dimension(d) {
  demand(d && id(d.id) && id(d.fieldGroupId) && text(d.fieldKey) && text(d.name) &&
    ['single_select','multi_select'].includes(d.type) && count(d.sequence) && Array.isArray(d.templateVersions) &&
    d.templateVersions.length>0 && d.templateVersions.every(v=>count(v) && v>0) &&
    new Set(d.templateVersions).size===d.templateVersions.length && typeof d.templateName==='string' && text(d.nodeName))
  return {id:d.id,fieldGroupId:d.fieldGroupId,fieldKey:d.fieldKey,name:d.name,type:d.type,sequence:d.sequence,
    templateName:d.templateName,nodeName:d.nodeName,templateVersions:d.templateVersions.slice(),
    label:`${d.name}（版本 ${d.templateVersions.join('、')}）`}
}
function denominator(r,samples) {
  demand(['filledSampleCount','emptySampleCount','notApplicableSampleCount'].every(k=>count(r[k])) &&
    r.filledSampleCount+r.emptySampleCount+r.notApplicableSampleCount<=samples)
  return {filledSampleCount:r.filledSampleCount,emptySampleCount:r.emptySampleCount,notApplicableSampleCount:r.notApplicableSampleCount}
}
function percent(n,total) {return `${total ? Math.round(n*1000/total)/10 : 0}%`}
function formatAnalysisPage(raw) {
  demand(raw && utf8Bytes(JSON.stringify(raw))<=512*1024 && raw.schemaVersion===1 && VIEWS.includes(raw.view) &&
    ['all','authorized'].includes(raw.scope) && typeof raw.incomplete==='boolean' && count(raw.sampleCount) &&
    count(raw.totalCount) && Array.isArray(raw.items) && raw.items.length<=50 && raw.items.length<=raw.totalCount &&
    typeof raw.hasMore==='boolean' && typeof raw.nextCursor==='string' && raw.nextCursor.length<=2048 &&
    (raw.hasMore ? raw.nextCursor.length>0 : raw.nextCursor==='') && Array.isArray(raw.dimensionMetadata) && Array.isArray(raw.linkages))
  const context=normalizeSelection(raw.context);demand(context.view===raw.view)
  const dimensions=raw.dimensionMetadata.map(dimension),byId=new Map(dimensions.map(d=>[d.id,d]));demand(byId.size===dimensions.length)
  const links=raw.linkages.map(l=>{demand(l && id(l.id) && Array.isArray(l.dimensionIds) && l.dimensionIds.length===8 &&
    l.dimensionIds.every(id) && new Set(l.dimensionIds).size===8 && Array.isArray(l.templateVersions) &&
    l.templateVersions.every(v=>count(v) && v>0));return {id:l.id,dimensionIds:l.dimensionIds.slice(),
      templateVersions:l.templateVersions.slice(),label:`商品关联（版本 ${l.templateVersions.join('、')}）`}})
  demand(new Set(links.map(l=>l.id)).size===links.length && ['next','attributes','none'].includes(raw.productStage))
  if(raw.view!=='product') demand(raw.productStage==='none')
  const denom=denominator(raw,raw.sampleCount),bundled=raw.view==='node' || raw.view==='product' && raw.productStage==='attributes'
  const seen=new Set()
  const items=raw.items.map(item=>{
    if(raw.view==='catalog') {
      demand(item && id(item.id) && !seen.has(item.id) && typeof item.templateName==='string' && text(item.nodeName) &&
        Array.isArray(item.templateVersions) && item.templateVersions.every(v=>count(v)&&v>0) && count(item.sampleCount) && item.sampleCount<=raw.sampleCount &&
        count(item.fieldCount) && item.fieldCount>0)
      seen.add(item.id);return {id:item.id,templateName:item.templateName,nodeName:item.nodeName,versionLabel:item.templateVersions.join('、'),
        sampleCount:item.sampleCount,fieldCount:item.fieldCount}
    }
    if(bundled) {
      demand(item && byId.has(item.id) && !seen.has(item.id) && count(item.totalOptionCount) && item.totalOptionCount>0 &&
        Array.isArray(item.options) && item.options.length<=10 && item.options.length<=item.totalOptionCount)
      seen.add(item.id);const d=byId.get(item.id),denom=denominator(item,raw.sampleCount),labels=new Set()
      const options=item.options.map(o=>{demand(o && text(o.label) && !labels.has(o.label) && count(o.count) && o.count>0 && o.count<=denom.filledSampleCount)
        labels.add(o.label);return {label:o.label,count:o.count,percent:percent(o.count,denom.filledSampleCount)}})
      return {...d,...denom,totalOptionCount:item.totalOptionCount,options}
    }
    demand(item && Array.isArray(item.values) && dimensions.length>0 && item.values.length===dimensions.length &&
      item.values.every(text) && count(item.count) && item.count>0 && item.count<=denom.filledSampleCount)
    const key=JSON.stringify(item.values);demand(!seen.has(key));seen.add(key)
    return {key,values:item.values.slice(),label:item.values.join(' / '),
      dimensions:dimensions.map((d,i)=>({id:d.id,name:d.name,value:item.values[i]})),
      count:item.count,percent:percent(item.count,denom.filledSampleCount)}
  })
  if(['field','pair'].includes(raw.view)) demand(JSON.stringify(dimensions.map(d=>d.id))===JSON.stringify(context.dimensionIds))
  return {view:raw.view,scope:raw.scope,incomplete:raw.incomplete,sampleCount:raw.sampleCount,...denom,totalCount:raw.totalCount,
    items,dimensionMetadata:dimensions,linkages:links,productStage:raw.productStage,context,hasMore:raw.hasMore,nextCursor:raw.nextCursor,
    bundled,scopeNotice:raw.scope==='all'?'全部符合条件的售后':'仅统计你当前有权限的售后',
    explanation:raw.view==='pair'?'同节点实际共现；多选可贡献多个值对，占比合计可能超过100%，不代表因果关系。':'按最终有效节点样本计数，多选每个选中项各计一次。'}
}
function reduceAnalysisSelection(selection,event) {
  const prior=selection || catalogSelection(),base={...prior,dimensionIds:prior.dimensionIds.slice(),filters:prior.filters.map(f=>({...f}))}
  if(event.type==='catalog') return catalogSelection()
  if(event.type==='node') return {...catalogSelection(),view:'node',nodeGroupId:event.id}
  if(event.type==='field') return {...base,view:'field',linkageId:'',dimensionIds:[event.id]}
  if(event.type==='product') return {...base,view:'product',linkageId:event.id,dimensionIds:[],filters:[]}
  if(event.type==='productValue') return {...base,view:'product',filters:[...base.filters.slice(0,event.index),{dimensionId:event.dimensionId,value:event.value}]}
  if(event.type==='backProduct') return {...base,view:'product',filters:base.filters.slice(0,-1)}
  if(event.type==='resetProduct') return {...base,view:'product',filters:[]}
  if(event.type==='combinations') return {...base,view:'combinations'}
  if(event.type==='pair') return {...base,view:'pair',linkageId:'',dimensionIds:event.ids.slice(),filters:[]}
  throw new Error('INVALID_ANALYSIS_EVENT')
}
module.exports={catalogSelection,normalizeSelection,formatAnalysisPage,reduceAnalysisSelection}
