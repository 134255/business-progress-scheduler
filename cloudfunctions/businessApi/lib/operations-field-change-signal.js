'use strict'
const c=require('./operations-field-recovery-contract')
const {ownExactAccountIds}=require('./account-relationship-schema')
const ACTIONS=new Set(['submitFeedback','saveAndSubmitNodeForReview','submitNodeForReview','submitReviewVote',
  'decideNodeRoute','decideOptionalTailNode','rejectPreviousNode','updateBusinessMetadata','closeBusinessLine','amendFrozenBusiness'])
const NODES=new Set(['submitFeedback','saveAndSubmitNodeForReview','submitNodeForReview','decideNodeRoute','decideOptionalTailNode','rejectPreviousNode'])
function value(object,key){return object==null?undefined:c.own(object,key)}
function createOperationsFieldChangeSignal({db,queue,enabled=false}={}) {
  if(enabled===true&&(!db||!queue||typeof queue.enqueue!=='function'))throw new TypeError('enabled signal requires database and queue')
  async function enqueueAfterMutation({actor,action,payload={},result={}}) {
    if(enabled!==true)return 'disabled'
    if(!ACTIONS.has(action))return 'ignored'
    const userId=c.id(value(actor,'_id'))
    const user=await c.read(db,'users',userId)
    c.demand(user&&value(user,'status')==='active'&&['user','super_admin'].includes(value(user,'role')))
    let lineId=value(result,'businessLineId'),node
    if(action==='submitReviewVote') {
      const round=await c.read(db,'node_review_rounds',c.id(value(payload,'reviewRoundId')||value(result,'reviewRoundId')))
      c.demand(round)
      node=await c.read(db,'business_nodes',c.id(value(round,'nodeId')))
      c.demand(node&&value(node,'businessLineId')===value(round,'businessLineId'))
      const actual=c.id(value(round,'businessLineId'))
      if(lineId!==undefined)c.demand(lineId===actual)
      lineId=actual
    } else if(NODES.has(action)) {
      const nodeId=c.id(value(payload,action==='rejectPreviousNode'?'currentNodeId':'nodeId')||value(result,'nodeId'))
      node=await c.read(db,'business_nodes',nodeId);c.demand(node)
      const actual=c.id(value(node,'businessLineId'))
      if(lineId!==undefined)c.demand(lineId===actual)
      const supplied=value(payload,'businessLineId');if(supplied!==undefined)c.demand(supplied===actual)
      lineId=actual
    } else {
      if(lineId===undefined&&action==='updateBusinessMetadata')lineId=value(result,'id')
      if(lineId===undefined)lineId=value(payload,'businessLineId')
      const supplied=value(payload,'businessLineId');if(supplied!==undefined)c.demand(lineId===supplied)
    }
    const line=await c.read(db,'business_lines',c.id(lineId));c.demand(line)
    if(value(user,'role')!=='super_admin') {
      const managers=ownExactAccountIds(line,'managerUserIds',{nonEmpty:true}),members=ownExactAccountIds(line,'memberUserIds',{nonEmpty:true})
      c.demand(managers&&members&&(managers.includes(userId)||members.includes(userId)))
    }
    await queue.enqueue({businessLineId:lineId})
    return 'queued'
  }
  return {enqueueAfterMutation}
}
module.exports={createOperationsFieldChangeSignal}
