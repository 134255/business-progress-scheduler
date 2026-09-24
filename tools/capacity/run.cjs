'use strict'
const {fork}=require('node:child_process')
const {listScenarios,runScenario}=require('./scenarios.cjs')
const METRICS=['reads','queryReads','documentReads','returnedRows','transactions','maxTransactionOperations','peakActiveReads','writeAttempts']
const COUNTS=['sampledNodes','responseBytes','pages','rows','totalRows','pendingProcessing','pendingReviews','unreadNotifications','accounts','isolationFailures','firstPageReads','lastPageReads']
const OUTCOMES=['ok','known_limit','incomplete','test_aborted','error']
const numeric=value=>Number.isSafeInteger(value)&&value>=0?value:null
function projectResult(descriptor,raw={}) {
  const outcome=raw?.metrics?.writeAttempts>0?'error':OUTCOMES.includes(raw?.outcome)?raw.outcome:'error'
  return {schemaVersion:1,scenario:descriptor.name||descriptor.scenario,profile:descriptor.profile,measurement:'local-synthetic',
    outcome,complete:outcome==='ok'&&raw?.complete===true,
    counts:Object.fromEntries(COUNTS.filter(k=>['sampledNodes','responseBytes','pages','rows'].includes(k)||Object.hasOwn(raw?.counts||{},k)).map(k=>[k,numeric(raw?.counts?.[k])])),
    metrics:raw?.metrics?Object.fromEntries(METRICS.map(k=>[k,numeric(raw.metrics[k])])):null}
}
function parseArgs(args) {
  const values={}
  for(let i=0;i<args.length;i+=2) {
    const key=args[i]
    if(!['--profile','--scenario','--max-ms','--max-reads','--max-heap-mb'].includes(key)||Object.hasOwn(values,key)||!args[i+1]) throw Error('INVALID_ARGUMENT')
    values[key]=args[i+1]
  }
  const profile=values['--profile']||'smoke',scenarios=listScenarios(profile)
  const selected=values['--scenario']?scenarios.filter(s=>s.name===values['--scenario']):scenarios
  if(!selected.length) throw Error('INVALID_SCENARIO')
  function limit(key,fallback,max) {
    const text=values[key]
    if(text===undefined) return fallback
    if(!/^[1-9]\d*$/.test(text)||!Number.isSafeInteger(+text)||+text>max) throw Error('INVALID_BUDGET')
    return +text
  }
  return {profile,scenarios:selected,budgets:{maxMs:limit('--max-ms',30000,300000),maxReads:limit('--max-reads',20000,2000000),maxHeapBytes:limit('--max-heap-mb',256,2048)*1048576}}
}
function childEnvironment(environment=process.env) {
  return Object.fromEntries(['SystemRoot','SYSTEMROOT','TEMP','TMP','PATH','Path'].filter(k=>typeof environment[k]==='string').map(k=>[k,environment[k]]))
}
function runIsolated(descriptor,budgets,{spawnWorker}={}) {
  return new Promise(resolve=>{
    let child,received=null,timedOut=false,spawnError=false
    try {child=spawnWorker?spawnWorker():fork(__filename,['--worker'],{env:childEnvironment(),
      execArgv:[`--max-old-space-size=${Math.ceil(budgets.maxHeapBytes/1048576)}`],stdio:['ignore','ignore','ignore','ipc']})}
    catch {resolve(projectResult(descriptor,{outcome:'error'}));return}
    const timer=setTimeout(()=>{timedOut=true;child.kill()},budgets.maxMs)
    child.once('message',message=>{received=projectResult(descriptor,message)})
    child.once('error',()=>{spawnError=true})
    child.once('close',(code,signal)=>{
      clearTimeout(timer)
      if(timedOut||signal) resolve(projectResult(descriptor,{outcome:'test_aborted'}))
      else if(spawnError||code!==0||!received) resolve(projectResult(descriptor,{outcome:'error'}))
      else resolve(received)
    })
    child.send({name:descriptor.name,profile:descriptor.profile,budgets},error=>{if(error) {spawnError=true;child.kill()}})
  })
}
async function main(args) {
  let options
  try {options=parseArgs(args)} catch {process.stderr.write('INVALID_ARGUMENT\n');return 2}
  let failed=false
  for(const descriptor of options.scenarios) {
    const result=await runIsolated(descriptor,options.budgets)
    process.stdout.write(JSON.stringify(result)+'\n')
    if(result.outcome!=='ok'||!result.complete) failed=true
  }
  return failed?1:0
}
if(require.main===module) {
  if(typeof process.send==='function'&&process.argv.length===3&&process.argv[2]==='--worker') {
    process.once('message',async input=>{
      let result
      try {result=await runScenario(input)} catch {result={outcome:'error'}}
      process.send(projectResult(input,result),()=>process.disconnect())
    })
  } else main(process.argv.slice(2)).then(code=>{process.exitCode=code},()=>{process.exitCode=1})
}
module.exports={parseArgs,projectResult,runIsolated,childEnvironment,main}
