'use strict'
const coded=code=>Object.assign(new Error(code),{code})
const clone=value=>value===undefined?undefined:structuredClone(value)
function arraySource(seed) {
  const stored=new Map(Object.entries(seed).map(([name,rows])=>[name,new Map(rows.map(row=>[row._id,clone(row)]))]))
  return {get:(name,id)=>clone(stored.get(name)?.get(id)),
    entries:function*(name){for(const row of stored.get(name)?.values()||[]) yield clone(row)}}
}
// Match the existing local oracle, not a claim about SDK mixed-type ordering.
function matches(row,criteria) {
  return Object.entries(criteria).every(([key,v])=>{
    if(v?.__operator==='and') return v.values.every(entry=>matches(row,{[key]:entry}))
    if(v?.__operator==='eq') return row[key]===v.value || row[key] instanceof Date&&v.value instanceof Date&&+row[key]===+v.value
    if(v?.__operator==='gt') return String(row[key]||'')>String(v.value)
    if(v?.__operator==='gte') return row[key]!==undefined&&row[key]>=v.value
    if(v?.__operator==='lt') return row[key]!==undefined&&row[key]<v.value
    if(v?.__operator==='lte') return row[key]!==undefined&&row[key]<=v.value
    if(v?.__operator==='in') return v.values.includes(row[key])
    return Array.isArray(row[key])?row[key].includes(v):row[key]===v
  })
}
function validateValue(v) {
  if(!v || typeof v!=='object' || v instanceof Date) return
  if(['eq','gt','gte','lt','lte'].includes(v.__operator)) {validateValue(v.value);return}
  if(['in','and'].includes(v.__operator)&&Array.isArray(v.values)) {v.values.forEach(validateValue);return}
  throw coded('UNSUPPORTED_QUERY')
}
const closed=object=>new Proxy(object,{get(target,key){
  if(Reflect.has(target,key)||typeof key==='symbol'||key==='then') return Reflect.get(target,key)
  throw coded('UNSUPPORTED_QUERY')
}})
function createReadonlyDatabase({source,maxReads=20000,maxMs=30000,maxHeapBytes=268435456,beforeRead,afterTransaction}) {
  if(!source || typeof source.get!=='function' || typeof source.entries!=='function') throw coded('INVALID_SOURCE')
  for(const limit of [maxReads,maxMs,maxHeapBytes]) if(!Number.isSafeInteger(limit)||limit<=0) throw coded('INVALID_BUDGET')
  const started=performance.now()
  let overlay=new Map(),active=0
  const counters={reads:0,queryReads:0,documentReads:0,returnedRows:0,transactions:0,maxTransactionOperations:0,peakActiveReads:0,writeAttempts:0}
  const forbid=()=>{counters.writeAttempts++;throw coded('READONLY_VIOLATION')}
  function budget() {if(performance.now()-started>maxMs||process.memoryUsage().heapUsed>maxHeapBytes) throw coded('MEASUREMENT_BUDGET')}
  async function read(operation,run) {
    budget()
    if(counters.reads>=maxReads) throw coded('MEASUREMENT_BUDGET')
    counters.reads++;counters[operation.id===undefined?'queryReads':'documentReads']++
    active++;counters.peakActiveReads=Math.max(counters.peakActiveReads,active)
    try {
      if(beforeRead) await beforeRead(operation)
      await new Promise(resolve=>setImmediate(resolve))
      budget()
      const result=run()
      budget()
      counters.returnedRows+=Array.isArray(result.data)?result.data.length:result.data?1:0
      return result
    } finally {active--}
  }
  const key=(name,id)=>JSON.stringify([name,id])
  function get(name,id,view) {return clone(view.has(key(name,id))?view.get(key(name,id)):source.get(name,id))}
  function* entries(name,view) {
    const seen=new Set()
    for(const row of source.entries(name)) {seen.add(row._id);const value=view.has(key(name,row._id))?clone(view.get(key(name,row._id))):row;if(value) yield value}
    for(const [k,row] of view) {const [collection,id]=JSON.parse(k);if(collection===name&&!seen.has(id)&&row) yield clone(row)}
  }
  function collection(name,tx=null,criteria={},order=[],offset=0,maximum=100) {
    const queryAllowed=()=>{if(tx) throw coded('TRANSACTION_QUERY_FORBIDDEN')}
    return closed({
      doc(id) {if(typeof id!=='string'||!id) throw coded('UNSUPPORTED_QUERY')
        return closed({get:()=>{
          if(tx && ++tx.operations>100) throw coded('TRANSACTION_BUDGET')
          const view=tx?tx.view:overlay
          return read({collection:name,id,transaction:!!tx},()=>{
            const data=get(name,id,view)
            if(!data) throw new Error(`document.get:fail document with _id ${id} does not exist`)
            return {data}
          })
        },set:forbid,update:forbid,remove:forbid})
      },
      where(next) {queryAllowed();if(!next||typeof next!=='object'||Array.isArray(next)) throw coded('UNSUPPORTED_QUERY')
        Object.values(next).forEach(validateValue);return collection(name,tx,clone(next),order,offset,maximum)},
      orderBy(field,direction) {queryAllowed();if(typeof field!=='string'||!['asc','desc'].includes(direction)) throw coded('UNSUPPORTED_QUERY')
        return collection(name,tx,criteria,[...order,[field,direction]],offset,maximum)},
      skip(value) {queryAllowed();if(!Number.isSafeInteger(value)||value<0) throw coded('UNSUPPORTED_QUERY')
        return collection(name,tx,criteria,order,value,maximum)},
      limit(value) {queryAllowed();if(!Number.isSafeInteger(value)||value<=0) throw coded('UNSUPPORTED_QUERY')
        return collection(name,tx,criteria,order,offset,value)},
      get() {queryAllowed();const view=overlay;return read({collection:name,transaction:false},()=>{
        const rows=[];let scanned=0
        for(const row of entries(name,view)) {if(++scanned%128===0) budget();if(matches(row,criteria)) rows.push(row)}
        for(const [field,direction] of order.slice().reverse()) rows.sort((a,b)=>
          String(a[field]||'').localeCompare(String(b[field]||''))*(direction==='desc'?-1:1))
        return {data:rows.slice(offset,offset+maximum)}
      })},
      count() {queryAllowed();const view=overlay;return read({collection:name,transaction:false},()=>{
        let total=0,scanned=0
        for(const row of entries(name,view)) {if(++scanned%128===0) budget();if(matches(row,criteria)) total++}
        return {total}
      })},add:forbid,set:forbid,update:forbid,remove:forbid
    })
  }
  const command=closed({and:(...values)=>({__operator:'and',values}),in:values=>({__operator:'in',values}),
    ...Object.fromEntries(['eq','gt','gte','lt','lte'].map(op=>[op,value=>({__operator:op,value})]))})
  const db=closed({command,collection,serverDate:forbid,
    async runTransaction(callback) {
      budget();counters.transactions++
      const tx={operations:0,view:overlay}
      try {return await callback(closed({collection:name=>collection(name,tx)}))}
      finally {counters.maxTransactionOperations=Math.max(counters.maxTransactionOperations,tx.operations)
        if(afterTransaction) await afterTransaction({operations:tx.operations})}
    }})
  return {db,metrics:()=>({...counters}),replaceForTest(name,id,document) {
    const next=new Map(overlay);next.set(key(name,id),clone(document));overlay=next
  }}
}
module.exports={createReadonlyDatabase,arraySource}
