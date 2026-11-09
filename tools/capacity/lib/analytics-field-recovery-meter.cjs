'use strict'
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {AsyncLocalStorage}=require('node:async_hooks')
const ROOT=path.resolve(__dirname,'../../..')
// Test-only adapter: stored documents are already copied on every read/write.
// Keep the original conflict/rollback algorithm, copying its maps rather than
// deep-cloning every unrelated document for every fixed-document transaction.
function createCapacityDatabase(seed={},options={},sourceFile=path.join(ROOT,'cloudfunctions/businessApi/test/helpers/fake-cloud-database.js')) {
  let source=fs.readFileSync(sourceFile,'utf8')
  const old='new Map([...collection.entries()].map(([id, document]) => [id, clone(document)]))'
  if(source.split(old).length!==3)throw new Error('Capacity adapter source shape changed; review before use')
  source=source.split(old).join('new Map(collection)')
  const loaded=new Module(sourceFile,module);loaded.filename=sourceFile;loaded.paths=Module._nodeModulePaths(path.dirname(sourceFile));loaded._compile(source,sourceFile)
  return loaded.exports.createFakeCloudDatabase(seed,options)
}
function createOperationMeter(original) {
  const context=new AsyncLocalStorage(),cells=new Map()
  const empty=()=>({get:0,query:0,set:0,update:0,remove:0,returnedDocuments:0,responseBytes:0,writeBytes:0,acknowledgedWrites:0,transactionsStarted:0,transactionCallbacks:0,transactionFailures:0})
  function cell(collection){const phase=context.getStore()||'unclassified',key=JSON.stringify([phase,collection]);if(!cells.has(key))cells.set(key,{phase,collection,...empty()});return cells.get(key)}
  function builder(value,name,documentId,attempt) {
    return new Proxy(value,{get(target,key){
      if(['get','set','update','remove'].includes(key))return async(...args)=>{
        const operation=key==='get'&&documentId===undefined?'query':key,s=cell(name);s[operation]++
        if(key!=='get')s.writeBytes+=Buffer.byteLength(JSON.stringify(args[0]&&args[0].data||{}))
        const result=await target[key](...args)
        if(key==='get'){const data=result.data,docs=Array.isArray(data)?data:data==null?[]:[data];s.returnedDocuments+=docs.length;s.responseBytes+=Buffer.byteLength(JSON.stringify(data))}
        else if(attempt)attempt.push(s)
        else s.acknowledgedWrites++
        return result
      }
      if(['doc','field','where','orderBy','limit','skip'].includes(key))return(...args)=>builder(target[key](...args),name,key==='doc'?args[0]:documentId,attempt)
      return typeof target[key]==='function'?target[key].bind(target):target[key]
    }})
  }
  function database(value,attempt) {
    return new Proxy(value,{get(target,key){
      if(key==='collection')return name=>builder(target.collection(name),name,undefined,attempt)
      if(key==='runTransaction')return async callback=>{
        const s=cell('__transactions__');s.transactionsStarted++;let writes=[]
        try {const result=await target.runTransaction(async tx=>{s.transactionCallbacks++;writes=[];return callback(database(tx,writes))});for(const w of writes)w.acknowledgedWrites++;return result}
        catch(e){s.transactionFailures++;throw e}
      }
      return typeof target[key]==='function'?target[key].bind(target):target[key]
    }})
  }
  function report(){
    const totals=empty(),byPhase={},byCollection={}
    for(const row of cells.values())for(const k of Object.keys(totals)){
      totals[k]+=row[k];(byPhase[row.phase]||=empty())[k]+=row[k];(byCollection[row.collection]||=empty())[k]+=row[k]
    }
    return {totals,byPhase,byCollection}
  }
  return {db:database(original),inPhase:(name,work)=>context.run(name,work),report}
}
module.exports={createCapacityDatabase,createOperationMeter}
