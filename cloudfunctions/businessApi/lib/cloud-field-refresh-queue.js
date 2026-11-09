'use strict'
const crypto=require('node:crypto')
const c=require('./operations-field-recovery-contract')
function createCloudFieldRefreshQueue({db,clock=()=>new Date(),tokenFactory=()=>crypto.randomBytes(16).toString('hex')}={}) {
  if(!db||typeof db.runTransaction!=='function'||typeof clock!=='function'||typeof tokenFactory!=='function')throw new TypeError('queue database, clock and tokenFactory required')
  function now(current) {const at=c.date(clock());if(current)c.demand(at>=current.updatedAt);return at}
  async function enqueue({businessLineId}) {
    const docId=c.key(businessLineId),enqueueToken=c.token(tokenFactory())
    return db.runTransaction(async tx=>{
      const raw=await c.read(tx,c.QUEUE,docId),current=raw?c.job(raw):null
      if(current)c.demand(current.enqueueToken!==enqueueToken)
      const next={schemaVersion:1,businessLineId,enqueueToken,revision:c.integer((current?current.revision:0)+1,1),
        afterNodeId:null,discoveryDone:false,seenCount:0,pendingNodeIds:[],retryAfterId:null,visitNext:'new',updatedAt:now(current)}
      await tx.collection(c.QUEUE).doc(docId).set({data:next})
      return {id:docId,enqueueToken,revision:next.revision}
    })
  }
  async function listJobs({afterId=null,limit=8,check=()=>{}}={}) {
    c.integer(limit,1,8);if(afterId!==null)c.id(afterId)
    check();const response=await db.collection(c.QUEUE).where(afterId===null?{}:{_id:db.command.gt(afterId)}).orderBy('_id','asc').limit(limit).get();check()
    const rows=c.own(response,'data');c.demand(Array.isArray(rows)&&Object.getPrototypeOf(rows)===Array.prototype&&rows.length<=limit)
    let previous=afterId
    // Do not validate a poisoned job here: the scheduler must first durably
    // move its fair rotation hint, then fail that one job at its own visit.
    for(let i=0;i<rows.length;i++) {
      const d=Object.getOwnPropertyDescriptor(rows,String(i));c.demand(d&&Object.hasOwn(d,'value'))
      const rowId=c.id(c.own(d.value,'_id'));c.demand(previous===null||rowId>previous);previous=rowId
    }
    return {jobs:rows,tail:rows.length<limit}
  }
  async function claimVisit({observed,limit=8,check=()=>{}}) {
    const old=c.job(observed);c.integer(limit,1,8);check()
    const pending=old.pendingNodeIds.slice().sort()
    let at=pending.findIndex(n=>old.retryAfterId===null||n>old.retryAfterId);if(at<0)at=0
    const rotated=[...pending.slice(at),...pending.slice(0,at)]
    let retries=[]
    if(old.discoveryDone)retries=rotated.slice(0,limit)
    else if(pending.length&&(limit>1||old.visitNext==='retry'))retries=rotated.slice(0,1)
    const size=old.discoveryDone?0:limit-retries.length
    let rows=[],tail=old.discoveryDone
    if(size) {
      check();const response=await db.collection('business_nodes').where({businessLineId:old.businessLineId,
        ...(old.afterNodeId===null?{}:{_id:db.command.gt(old.afterNodeId)})}).orderBy('_id','asc').limit(size).get();check()
      rows=c.own(response,'data');c.demand(Array.isArray(rows)&&Object.getPrototypeOf(rows)===Array.prototype&&rows.length<=size)
      let prev=old.afterNodeId
      for(let i=0;i<rows.length;i++) {
        const d=Object.getOwnPropertyDescriptor(rows,String(i));c.demand(d&&Object.hasOwn(d,'value'))
        const nodeId=c.id(c.own(d.value,'_id'));c.demand(c.own(d.value,'businessLineId')===old.businessLineId&&(prev===null||nodeId>prev));prev=nodeId
      }
      c.demand(old.seenCount+rows.length<=100);tail=rows.length<size
    }
    const newIds=rows.map(r=>c.own(r,'_id')),nodeIds=[...retries,...newIds]
    c.demand(new Set(nodeIds).size===nodeIds.length)
    check();return db.runTransaction(async tx=>{
      const raw=await c.read(tx,c.QUEUE,old._id,check),current=raw?c.job(raw):null
      if(!c.same(current,old))return null
      const next={...current,revision:c.integer(current.revision+1,1),pendingNodeIds:[...new Set([...current.pendingNodeIds,...newIds])],
        afterNodeId:newIds.length?newIds.at(-1):current.afterNodeId,seenCount:current.seenCount+newIds.length,
        // Rotate after the first selected node even if processing stops before
        // ack. Using the last selected node wraps a whole pending page to the
        // same poisoned first node forever; every selection remains pending.
        discoveryDone:tail,retryAfterId:nodeIds.length?nodeIds[0]:current.retryAfterId,
        visitNext:current.visitNext==='new'?'retry':'new',updatedAt:now(current)}
      check()
      if(tail&&!next.pendingNodeIds.length) {
        await tx.collection(c.QUEUE).doc(old._id).remove();check()
        return {claim:null,candidates:[],jobFinished:true}
      }
      await tx.collection(c.QUEUE).doc(old._id).set({data:c.data(next)});check()
      return {claim:{id:old._id,enqueueToken:next.enqueueToken,revision:next.revision,nodeIds},
        candidates:[...retries.map(_id=>({_id,businessLineId:old.businessLineId})),...rows],jobFinished:false}
    })
  }
  async function ackVisit({claim,completedIds,check=()=>{}}) {
    c.exact(claim,['id','enqueueToken','revision','nodeIds']);c.id(claim.id);c.token(claim.enqueueToken);c.integer(claim.revision,1)
    const requested=c.ids(claim.nodeIds,8),completed=c.ids(completedIds,8);c.demand(completed.every(n=>requested.includes(n)))
    if(!completed.length)return {finished:false,unchanged:true}
    check();return db.runTransaction(async tx=>{
      const raw=await c.read(tx,c.QUEUE,claim.id,check),current=raw?c.job(raw):null
      if(!current||current.enqueueToken!==claim.enqueueToken||current.revision!==claim.revision)return null
      c.demand(requested.every(n=>current.pendingNodeIds.includes(n)))
      const pending=current.pendingNodeIds.filter(n=>!completed.includes(n));check()
      if(current.discoveryDone&&!pending.length) {
        await tx.collection(c.QUEUE).doc(claim.id).remove();check();return {finished:true}
      }
      await tx.collection(c.QUEUE).doc(claim.id).set({data:c.data({...current,pendingNodeIds:pending,
        revision:c.integer(current.revision+1,1),updatedAt:now(current)})});check();return {finished:false}
    })
  }
  return {enqueue,listJobs,claimVisit,ackVisit}
}
module.exports={createCloudFieldRefreshQueue}
