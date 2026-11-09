'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {createFakeCloudDatabase}=require('../../businessApi/test/helpers/fake-cloud-database')
test('standalone worker queue bytes and crash-safe pending behavior match the API bundle',async()=>{
  for(const name of ['operations-field-recovery-contract.js','cloud-field-refresh-queue.js'])
    assert.deepEqual(fs.readFileSync(path.join(__dirname,'../lib',name)),fs.readFileSync(path.join(__dirname,'../../businessApi/lib',name)))
  const {createCloudFieldRefreshQueue}=require('../lib/cloud-field-refresh-queue')
  const fake=createFakeCloudDatabase({business_nodes:[{_id:'node-1',businessLineId:'line-1'}]})
  const queue=createCloudFieldRefreshQueue({db:fake.db})
  await queue.enqueue({businessLineId:'line-1'})
  const visit=await queue.claimVisit({observed:fake.documents('operations_field_refresh_queue')[0],limit:8})
  assert.deepEqual(visit.claim.nodeIds,['node-1'])
  assert.deepEqual(fake.documents('operations_field_refresh_queue')[0].pendingNodeIds,['node-1'])
})
