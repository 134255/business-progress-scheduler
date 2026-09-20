const FIELD_CSV_COLUMNS = Object.freeze([
  ['recordType','记录类型'],['dateBasis','筛选日期口径'],['templateName','模板名称'],['templateVersions','模板版本'],
  ['fieldKey','字段标识'],['fieldName','字段名称'],['fieldType','字段类型'],['fieldValue','字段内容'],
  ['optionValue','选项内容'],['occurrenceCount','出现次数'],['filledSampleCount','有效填写样本数'],
  ['emptySampleCount','未填写样本数'],['dataStatus','数据状态'],['fieldGroupId','字段兼容组'],
  ['originalValueJson','字段或选项原文（JSON）']
])
const ERROR_MESSAGES = Object.freeze({
  RANGE_TOO_LARGE:'数据范围过大，请缩小日期、模板或节点范围后重试。',
  REPORT_CHANGED:'数据或权限已变化，请重新导出。',
  REPORT_EXPIRED:'本次导出已过期，请重新导出。',
  INCOMPLETE_FIELD_DATA:'部分最终字段数据尚未补齐，暂不能导出完整文件，请稍后重试。',
  FIELD_SOURCE_INVALID:'部分字段来源暂时无法核实，请刷新后重试。',
  REPORT_CONFIGURATION_ERROR:'导出服务配置尚未就绪，请联系管理员。',
  FORBIDDEN:'当前账号无权查看或导出这些数据。'
})
function fieldErrorMessage(error,fallback) { return ERROR_MESSAGES[error && error.code] || fallback }
function count(value) { return Number.isSafeInteger(value) && value>=0 }
function formatFieldSummary(result,templates=[]) {
  if(!result || !['all','authorized'].includes(result.scope) || !count(result.sampledNodeCount) ||
      typeof result.incomplete!=='boolean' || !Array.isArray(result.groups)) throw new Error('INVALID_FIELD_SUMMARY')
  const fieldGroups=result.groups.map(group=>{
    if(!group || !['single_select','multi_select'].includes(group.fieldType) ||
        typeof group.id!=='string' || !Array.isArray(group.options) || !count(group.filledSampleCount) ||
        !count(group.emptySampleCount) || group.filledSampleCount+group.emptySampleCount>result.sampledNodeCount ||
        !Array.isArray(group.templateVersions)) throw new Error('INVALID_FIELD_SUMMARY')
    const labels=new Set()
    const maximum=Math.max(1,...group.options.map(item=>item.count))
    const options=group.options.map(item=>{
      if(!item || typeof item.label!=='string' || labels.has(item.label) || !count(item.count) ||
          item.count>group.filledSampleCount) throw new Error('INVALID_FIELD_SUMMARY')
      labels.add(item.label)
      return {label:item.label,count:item.count,width:`${Math.round(item.count*100/maximum)}%`}
    })
    // Deliberate allow-list: never put raw node fields/results into page state.
    return {id:group.id,fieldKey:group.fieldKey,fieldName:group.fieldName,fieldType:group.fieldType,
      templateName:group.templateName || (templates.find(item=>item.value===group.templateId)||{}).label || `历史模板 ${group.templateId}`,versionLabel:group.templateVersions.join('、'),
      nodeName:group.nodeName,filledSampleCount:group.filledSampleCount,emptySampleCount:group.emptySampleCount,options}
  })
  return {fieldGroups,fieldIncomplete:result.incomplete,
    fieldScopeNotice:result.scope==='all'?'全部符合条件的售后':'仅统计你当前有权限的售后',
    fieldNotice:result.incomplete?'部分最终数据尚未补齐，以下为已核实样本，暂不能导出完整文件。':
      `已核实 ${result.sampledNodeCount} 个完成节点；多选每个选中项各计一次。`}
}
function mergeFieldFilters(timing={},fields={}) {
  function merge(key,id) {
    const map=new Map()
    for(const item of [...(fields[key]||[]),...(timing[key]||[])]) if(item && typeof item[id]==='string') map.set(item[id],item)
    return [...map.values()]
  }
  return {...timing,templates:merge('templates','templateId'),stableNodes:merge('stableNodes','stableNodeId').sort((a,b)=>a.sequence-b.sequence),
    businesses:merge('businesses','businessLineId'),processors:merge('processors','token'),reviewers:merge('reviewers','token'),
    templateVersions:[...new Set([...(timing.templateVersions||[]),...(fields.templateVersions||[])])].sort((a,b)=>b-a)}
}
function validReportPage(result) {
  return result && Array.isArray(result.items) && typeof result.hasMore==='boolean' &&
    result.items.every(validReportRow) &&
    (!result.hasMore || typeof result.nextCursor==='string' && result.nextCursor.length>0)
}
const FIELD_TYPES=['short_text','long_text','number','boolean','date','single_select','multi_select']
function ownText(row,key,allowEmpty=false) {
  return Object.prototype.hasOwnProperty.call(row,key) && typeof row[key]==='string' && (allowEmpty || row[key].trim().length>0)
}
function detailValue(row) {
  if(!ownText(row,'fieldValue',true) || !['有效','未填写'].includes(row.dataStatus)) return false
  const value=row.fieldValue
  let empty=value===''
  if(row.fieldType==='multi_select' && !empty) {
    let items
    try {items=JSON.parse(value)} catch (_) {return false}
    if(!Array.isArray(items) || items.some(item=>typeof item!=='string' || !item.trim()) || new Set(items).size!==items.length) return false
    empty=items.length===0
  }
  if(empty) return row.dataStatus==='未填写'
  if(row.dataStatus!=='有效') return false
  if(row.fieldType==='number') return value.trim()!=='' && Number.isFinite(Number(value))
  if(row.fieldType==='boolean') return ['是','否'].includes(value)
  if(row.fieldType==='date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value
  return true
}
function validReportRow(row) {
  if(!row || typeof row!=='object' || Array.isArray(row)) return false
  // Existing base export retains its established optional-cell protocol.
  if(row.recordType==='运营基础') return true
  if(!['字段明细','选项统计'].includes(row.recordType) || row.dateBasis!=='节点完成日期' ||
      !ownText(row,'templateName',true) || !ownText(row,'templateVersions') ||
      !row.templateVersions.split(',').every(value=>/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) ||
      !['fieldKey','fieldName','nodeName','fieldGroupId'].every(key=>ownText(row,key)) ||
      !/^[a-f0-9]{64}$/.test(row.fieldGroupId) || !FIELD_TYPES.includes(row.fieldType)) return false
  if(row.recordType==='字段明细') return ['businessCode','businessName','businessStatus','nodeCode','nodeCompletedAt'].every(key=>ownText(row,key)) &&
    Number.isFinite(Date.parse(row.nodeCompletedAt)) && detailValue(row)
  return ['single_select','multi_select'].includes(row.fieldType) && ownText(row,'optionValue') &&
    count(row.occurrenceCount) && count(row.filledSampleCount) && count(row.emptySampleCount) &&
    row.occurrenceCount<=row.filledSampleCount && row.dataStatus==='有效'
}
function reportCsvRows(rows) {
  return rows.map(row=> {
    if(row.recordType==='运营基础') return row
    // A JSON string/array starts with a quote/bracket, so CSV's formula guard and
    // newline normalization cannot change the original value inside this cell.
    const original=row.recordType==='选项统计'?row.optionValue:
      row.fieldType==='multi_select' && row.fieldValue!==''?JSON.parse(row.fieldValue):row.fieldValue
    return {...row,originalValueJson:JSON.stringify(original)}
  })
}
function utf8Bytes(text) {
  let bytes=0
  for(const char of text) {const code=char.codePointAt(0);bytes+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4}
  return bytes
}
module.exports={FIELD_CSV_COLUMNS,formatFieldSummary,mergeFieldFilters,fieldErrorMessage,validReportPage,reportCsvRows,utf8Bytes}
