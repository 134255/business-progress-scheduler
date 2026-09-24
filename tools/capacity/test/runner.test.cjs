'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {execFile,fork}=require('node:child_process')
const {promisify}=require('node:util'),path=require('node:path')
const {parseArgs,runIsolated,projectResult,childEnvironment}=require('../run.cjs')
const {outcomeFor}=require('../scenarios.cjs')
const execute=promisify(execFile),entry=path.resolve(__dirname,'../run.cjs')
test('strict offline CLI rejects unknown flags, production targets, unsafe and duplicate budgets',async()=>{
  assert.equal(parseArgs([]).profile,'smoke')
  for(const args of [['--env','production'],['--profile','unknown'],['--max-ms','NaN'],['--max-ms','0'],['--max-reads','-2'],
    ['--max-heap-mb','999999'],['--profile','smoke','--profile','year'],['--worker']])
    await assert.rejects(execute(process.execPath,[entry,...args]),e=>e.code===2)
})
test('real CLI prints aggregate JSON only and exits nonzero on measured abortion',async()=>{
  const {stdout}=await execute(process.execPath,[entry,'--scenario','field-summary'])
  const r=JSON.parse(stdout.trim());assert.equal(r.measurement,'local-synthetic');assert.equal(r.complete,true)
  assert.doesNotMatch(stdout,/cloud:\/\/|openid|fieldValues|memberUserIds|nodeCode|cap-line/)
  await assert.rejects(execute(process.execPath,[entry,'--scenario','field-summary','--max-reads','1']),e=>{
    assert.equal(JSON.parse(e.stdout).outcome,'test_aborted');return e.code===1
  })
})
test('projection removes exception messages, cursor, extra counts and unsafe metrics',()=>{
  const r=projectResult({scenario:'field-summary',profile:'smoke'},{outcome:'error',complete:true,
    error:'SECRET C:/private/customer.json',counts:{rows:1,private:'secret'},metrics:{reads:NaN,private:'secret'},nextCursor:'secret'})
  assert.equal(r.complete,false);assert.doesNotMatch(JSON.stringify(r),/secret|SECRET|customer|private|nextCursor/)
  assert.equal(outcomeFor({code:'RANGE_TOO_LARGE'}),'known_limit')
  assert.equal(outcomeFor({code:'FORBIDDEN'}),'error')
  assert.equal(outcomeFor({code:'REPORT_CHANGED'}),'error')
  assert.equal(outcomeFor(new Error('raw secret')),'error')
  assert.deepEqual(childEnvironment({SystemRoot:'safe',TEMP:'temp',PATH:'path',NODE_OPTIONS:'bad',SECRET:'bad'}),{SystemRoot:'safe',TEMP:'temp',PATH:'path'})
})
test('positive write attempts cannot pass the final output boundary',()=>{
  const r=projectResult({name:'field-summary',profile:'smoke'},{outcome:'ok',complete:true,metrics:{writeAttempts:1}})
  assert.equal(r.outcome,'error');assert.equal(r.complete,false)
})
test('unknown nonzero child exits remain errors, not budget abortions',async()=>{
  for(const exitCode of [1,7]) {
    const r=await runIsolated({name:'field-summary',profile:'smoke'},{maxMs:500,maxReads:20,maxHeapBytes:268435456},{spawnWorker(){
      const child=new (require('node:events').EventEmitter)()
      child.send=()=>setImmediate(()=>child.emit('close',exitCode,null));child.kill=()=>{}
      return child
    }})
    assert.equal(r.outcome,'error');assert.equal(r.complete,false)
  }
})
test('unresponsive real child is killed, awaited and never marked complete',async()=>{
  let child
  const r=await runIsolated({name:'field-summary',profile:'smoke'},{maxMs:150,maxReads:20,maxHeapBytes:268435456},
    {spawnWorker:()=>child=fork(path.join(__dirname,'hanging-worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],env:{}})})
  assert.equal(r.outcome,'test_aborted');assert.equal(r.complete,false)
  assert.ok(child.exitCode!==null||child.signalCode!==null)
})
test('real scenarios execute with network entry points forbidden and no SDK in dependency closure',async t=>{
  const originals=[]
  const deny=()=>{throw new Error('NETWORK_FORBIDDEN')}
  for(const [object,keys] of [[global,['fetch']],[require('node:http'),['get','request']],[require('node:https'),['get','request']],
    [require('node:net'),['connect','createConnection']],[require('node:tls'),['connect']],[require('node:dgram'),['createSocket']]])
    for(const key of keys) {originals.push([object,key,object[key]]);object[key]=deny}
  t.after(()=>{for(const [object,key,value] of originals) object[key]=value})
  const r=await require('../scenarios.cjs').runScenario({name:'field-summary',profile:'smoke'})
  assert.equal(r.outcome,'ok')
  for(const file of Object.keys(require.cache)) assert.doesNotMatch(file,/wx-server-sdk|cos-nodejs|cloudfunctions[\\/]businessApi[\\/]index\.js/)
})
