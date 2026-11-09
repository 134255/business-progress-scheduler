'use strict'
const crypto=require('node:crypto')
const c=require('./operations-field-recovery-contract')
const {createFieldRecoveryBudget}=require('./field-recovery-budget')
const KEYS=['schemaVersion','revision','queueAfterId','repairEpoch','repairActive','repairStartedAt','repairCompletedAt','nextRepairAt','updatedAt']
function state(raw,now) {
  if(!raw)return null
  c.exact(raw,KEYS,['_id']);c.demand(c.own(raw,'_id')===c.CONTROL&&c.own(raw,'schemaVersion')===1)
  const s={_id:c.CONTROL};for(const key of KEYS)s[key]=c.own(raw,key)
  c.integer(s.revision,1);c.token(s.repairEpoch)
  if(s.queueAfterId!==null)c.id(s.queueAfterId)
  c.demand(typeof s.repairActive==='boolean')
  s.updatedAt=c.date(s.updatedAt);s.repairStartedAt=c.date(s.repairStartedAt)
  c.demand(s.updatedAt.getTime()<=now&&s.repairStartedAt<=s.updatedAt)
  if(s.repairCompletedAt!==null) {s.repairCompletedAt=c.date(s.repairCompletedAt);c.demand(s.repairCompletedAt<=s.updatedAt)}
  if(s.repairActive)c.demand(s.nextRepairAt===null)
  else {
    s.nextRepairAt=c.date(s.nextRepairAt)
    c.demand(s.repairCompletedAt!==null&&s.repairCompletedAt>=s.repairStartedAt&&s.nextRepairAt.getTime()===s.repairCompletedAt.getTime()+c.HOUR)
  }
  return s
}
function createFieldChangePriorityRecovery({db,queue,sourceRecovery,clock=()=>new Date(),tokenFactory=()=>crypto.randomBytes(16).toString('hex')}={}) {
  if(!db||!queue||!sourceRecovery||typeof sourceRecovery.runRepairSlice!=='function'||typeof sourceRecovery.recoverCandidates!=='function')throw new TypeError('priority recovery dependencies required')
  async function runCycle({batchSize=40,timeBudgetMs=5000}={}) {
    c.integer(batchSize,1,40);c.integer(timeBudgetMs,0,5000)
    const counts={examined:0,generated:0,failed:0,hasMore:true}
    if(!timeBudgetMs)return counts
    const budget=createFieldRecoveryBudget({clock,timeBudgetMs}),check=budget.check
    let observed,remaining=batchSize
    async function mutate(change,proof) {
      check();return db.runTransaction(async tx=>{
        const fresh=state(await c.read(tx,'system_settings',c.CONTROL,check),budget.time())
        if(observed ? !fresh||fresh.revision!==observed.revision||fresh.repairEpoch!==observed.repairEpoch : fresh!==null)return null
        if(proof) {
          c.demand(proof.tail===true&&proof.cursorId===null)
          const cursor=await c.read(tx,'system_settings',c.CURSOR,check)
          if(proof.missing) {if(cursor!==null)return null}
          else {
            if(!cursor||c.own(cursor,'cursorId')!==null||c.own(cursor,'version')!==proof.version)return null
            c.exact(cursor,['cursorId','version','updatedAt'],['_id']);c.integer(c.own(cursor,'version'),1)
          }
        }
        const next={...change(fresh),_id:c.CONTROL,schemaVersion:1,revision:c.integer((fresh?fresh.revision:0)+1,1),updatedAt:new Date(budget.time())}
        state(next,budget.time());check()
        await tx.collection('system_settings').doc(c.CONTROL).set({data:c.data(next)});check();return next
      })
    }
    async function repair(size) {
      const result=await sourceRecovery.runRepairSlice({batchSize:size,budget})
      counts.examined+=result.counts.examined;counts.generated+=result.counts.generated;counts.failed+=result.counts.failed
      remaining-=result.counts.examined
      if(result.stopped)return false
      if(result.cursorProof) {
        const next=await mutate(s=>{
          // A real clock may tick between reads. Derive this invariant pair
          // from one callback-local instant, including transaction retries.
          const completedAt=budget.time()
          return {...s,repairActive:false,repairCompletedAt:new Date(completedAt),nextRepairAt:new Date(completedAt+c.HOUR)}
        },result.cursorProof)
        if(!next)return false
        observed=next
      }
      return true
    }
    try {
      observed=state(await c.read(db,'system_settings',c.CONTROL,check),budget.time())
      let listing=await queue.listJobs({afterId:observed?observed.queueAfterId:null,limit:8,check})
      if(!listing.jobs.length&&observed&&observed.queueAfterId!==null) {
        const next=await mutate(s=>({...s,queueAfterId:null}));if(!next)return counts;observed=next
        listing=await queue.listJobs({afterId:null,limit:8,check})
      }
      if(!observed||!observed.repairActive&&budget.time()>=observed.nextRepairAt.getTime()) {
        const epoch=c.token(tokenFactory())
        const next=await mutate(s=>({queueAfterId:s?s.queueAfterId:null,repairEpoch:epoch,repairActive:true,
          repairStartedAt:new Date(budget.time()),repairCompletedAt:s?s.repairCompletedAt:null,nextRepairAt:null}))
        if(!next)return counts;observed=next
      }
      if(observed.repairActive&&!await repair(Math.min(8,remaining)))return counts
      let visited=0
      for(const job of listing.jobs) {
        if(!remaining)break
        check();const jobId=c.id(c.own(job,'_id'))
        const next=await mutate(s=>({...s,queueAfterId:jobId}));if(!next)return counts;observed=next;visited++
        const allowance=Math.min(8,remaining)
        // Reserve before discovery: a malformed page or failed claim must not
        // let the next job spend the same raw-candidate budget again.
        remaining-=allowance
        let visit
        try {visit=await queue.claimVisit({observed:job,limit:allowance,check})}
        catch(error) {if(error&&error.code==='FIELD_REFRESH_QUEUE_INVALID'){counts.failed++;continue}throw error}
        if(!visit)return counts
        c.demand(visit.candidates.length<=allowance)
        remaining+=allowance-visit.candidates.length
        counts.examined+=visit.candidates.length
        if(visit.jobFinished)continue
        const result=await sourceRecovery.recoverCandidates({candidates:visit.candidates,budget})
        counts.generated+=result.counts.generated;counts.failed+=result.counts.failed
        if(result.stopped)return counts
        const completedIds=result.outcomes.filter(x=>x.status==='completed').map(x=>x.nodeId)
        if(await queue.ackVisit({claim:visit.claim,completedIds,check})===null)return counts
      }
      if(visited===listing.jobs.length&&listing.tail&&observed.queueAfterId!==null) {
        const next=await mutate(s=>({...s,queueAfterId:null}));if(!next)return counts;observed=next
      }
      if(!listing.jobs.length&&observed.repairActive&&remaining&&!await repair(remaining))return counts
      counts.hasMore=observed.repairActive||listing.jobs.length>0
    } catch(error) {
      if(!error||error.code!=='FIELD_RECOVERY_BUDGET')counts.failed++
    }
    return counts
  }
  return {runCycle}
}
module.exports={createFieldChangePriorityRecovery}
