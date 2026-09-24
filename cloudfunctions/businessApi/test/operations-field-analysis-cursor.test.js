const test=require('node:test'),assert=require('node:assert/strict')
let createOperationsFieldAnalysisCursor
try {({createOperationsFieldAnalysisCursor}=require('../lib/operations-field-analysis-cursor'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
const {createOperationsReportCursor}=require('../lib/operations-report-cursor')
test('analysis cursor is purpose isolated, authenticated, identity bound and expiring',()=>{
  assert.equal(typeof createOperationsFieldAnalysisCursor,'function')
  let now=0;const opts={secret:'synthetic-analysis-secret-'.repeat(3),clock:()=>new Date(now)}
  const codec=createOperationsFieldAnalysisCursor(opts),legacy=createOperationsReportCursor(opts)
  const body={actorId:'root',queryDigest:'a'.repeat(64),reportDigest:'b'.repeat(64),offset:10,expiresAt:1000}
  const token=codec.encode(body)
  assert.deepEqual(codec.decode(token,body),body)
  for(const bad of [legacy.encode(body),token.slice(0,-2)+'xx']) assert.throws(()=>codec.decode(bad,body),{code:'VALIDATION_ERROR'})
  assert.throws(()=>legacy.decode(token,body),{code:'VALIDATION_ERROR'})
  for(const binding of [{...body,actorId:'other'},{...body,queryDigest:'c'.repeat(64)}])
    assert.throws(()=>codec.decode(token,binding),{code:'VALIDATION_ERROR'})
  now=1000;assert.throws(()=>codec.decode(token,body),{code:'REPORT_EXPIRED'})
})
