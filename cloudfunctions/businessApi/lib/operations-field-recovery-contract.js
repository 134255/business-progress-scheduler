'use strict'
const crypto = require('node:crypto')
const QUEUE = 'operations_field_refresh_queue'
const CONTROL = 'operations-field-recovery-state-v1'
const CURSOR = 'operations-field-snapshot-cursor'
const HOUR = 3600000
function invalid() { const e=new Error('FIELD_REFRESH_QUEUE_INVALID');e.code='FIELD_REFRESH_QUEUE_INVALID';return e }
function demand(value) { if(!value) throw invalid() }
function own(object,key) {
  demand(object && typeof object==='object' && !Array.isArray(object) && [Object.prototype,null].includes(Object.getPrototypeOf(object)))
  const d=Object.getOwnPropertyDescriptor(object,key)
  demand(d ? Object.hasOwn(d,'value') : !(key in object))
  return d ? d.value : undefined
}
function exact(object,keys,optional=[]) {
  own(object,'_id')
  demand(Reflect.ownKeys(object).every(k=>typeof k==='string' && (keys.includes(k)||optional.includes(k))))
  for(const key of keys) demand(Object.hasOwn(object,key))
  for(const key of Reflect.ownKeys(object)) own(object,key)
  return object
}
function id(value) { demand(typeof value==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(value));return value }
function integer(value,min=0,max=Number.MAX_SAFE_INTEGER-1) { demand(Number.isSafeInteger(value)&&value>=min&&value<=max);return value }
function date(value) { demand(value instanceof Date && Object.getPrototypeOf(value)===Date.prototype && Number.isFinite(Date.prototype.getTime.call(value)));return new Date(Date.prototype.getTime.call(value)) }
function token(value) { demand(typeof value==='string' && /^[a-f0-9]{32}$/.test(value));return value }
function ids(value,max=100) {
  demand(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length<=max)
  demand(Reflect.ownKeys(value).length===value.length+1)
  const result=[]
  for(let i=0;i<value.length;i++) {const d=Object.getOwnPropertyDescriptor(value,String(i));demand(d&&Object.hasOwn(d,'value'));result.push(id(d.value))}
  demand(new Set(result).size===result.length);return result
}
function key(lineId) { return 'field-line-'+crypto.createHash('sha256').update(id(lineId)).digest('hex') }
const JOB_KEYS=['schemaVersion','businessLineId','enqueueToken','revision','afterNodeId','discoveryDone','seenCount','pendingNodeIds','retryAfterId','visitNext','updatedAt']
function job(value) {
  exact(value,JOB_KEYS,['_id']);demand(own(value,'schemaVersion')===1)
  const line=id(own(value,'businessLineId')), out={}
  for(const k of JOB_KEYS) out[k]=own(value,k)
  demand(own(value,'_id')===key(line));out._id=key(line)
  token(out.enqueueToken);integer(out.revision,1);integer(out.seenCount,0,100)
  if(out.afterNodeId!==null) id(out.afterNodeId)
  if(out.retryAfterId!==null) id(out.retryAfterId)
  demand(typeof out.discoveryDone==='boolean' && ['new','retry'].includes(out.visitNext))
  out.pendingNodeIds=ids(out.pendingNodeIds);demand(out.pendingNodeIds.length<=out.seenCount)
  demand(out.seenCount===0 ? out.afterNodeId===null : out.afterNodeId!==null)
  demand(out.pendingNodeIds.every(n=>out.afterNodeId!==null && n<=out.afterNodeId))
  out.updatedAt=date(out.updatedAt);return out
}
function data(value) { const {_id,...result}=value;return result }
function same(a,b) { return Boolean(a&&b&&a._id===b._id&&a.enqueueToken===b.enqueueToken&&a.revision===b.revision) }
function missing(error) {
  return error && (String(error.code||error.errCode||'').toUpperCase()==='DOCUMENT_NOT_FOUND' || /document\.get:fail.*document with _id .+ does not exist/i.test(String(error.message||error.errMsg||'')))
}
async function read(db,collection,docId,check=()=>{}) {
  check();let response
  try {response=await db.collection(collection).doc(docId).get()}
  catch(error) {check();if(missing(error))return null;throw error}
  check();const result=own(response,'data');if(result==null)return null
  demand(own(result,'_id')===docId);return result
}
module.exports={QUEUE,CONTROL,CURSOR,HOUR,invalid,demand,own,exact,id,integer,date,token,ids,key,job,data,same,read}
