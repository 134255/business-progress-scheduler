'use strict'
const {NOW}=require('./fixtures.cjs')
const {fieldSource}=require('../../cloudfunctions/businessApi/test/helpers/field-fixtures')
function createWorkspaceFixture({kind,count,readPercent=50}) {
  if(!['dashboard','list','previous'].includes(kind)||!Number.isSafeInteger(count)||count<0||count>100||![0,50,100].includes(readPercent))
    throw Object.assign(new Error('INVALID_FIXTURE'),{code:'INVALID_FIXTURE'})
  const actor={_id:'workspace-reader',role:'user',status:'active'}
  const seed={users:[actor],business_lines:[],business_nodes:[],node_review_rounds:[],node_review_votes:[],node_feedback:[],evidences:[],notifications:[]}
  if(kind==='previous') {
    const source=fieldSource({reviewed:true})
    source.line.memberUserIds.push(actor._id)
    const anchor={...source.node,_id:'next-node',nodeCode:'NEXT',status:'ready',routeState:'active',sequence:1}
    const revision=count+2
    source.node.latestFeedbackRevision=revision;source.feedback.revision=revision;source.round.feedbackRevision=revision
    seed.business_lines.push(source.line);seed.business_nodes.push(source.node,anchor)
    seed.node_feedback.push(source.feedback);seed.node_review_rounds.push(source.round);seed.node_review_votes.push(...source.votes)
    for(let i=0;i<count;i++) {
      const owner={...source.feedback,_id:`owner-${i}`,revision:i+1}
      seed.node_feedback.push(owner)
      const evidence={_id:`evidence-${i}`,businessLineId:source.line._id,nodeId:source.node._id,feedbackId:owner._id,
        feedbackRevision:owner.revision,attachmentState:'attached',fileName:`synthetic-${i}.jpg`,category:'image',extension:'jpg',size:100,
        storageStatus:'available',retentionScope:'business_line',retentionSource:'node_feedback',
        retentionStartedAt:new Date('2026-09-10'),purgeDueAt:new Date('2026-11-09')}
      seed.evidences.push(evidence);source.round.evidenceIds.push(evidence._id)
    }
    return {seed,actor,input:{actor,businessLineId:source.line._id,nodeId:source.node._id,anchorNodeId:anchor._id}}
  }
  for(let i=0;i<count;i++) {
    const id=String(i).padStart(4,'0')
    const line={_id:`line-${id}`,code:`CAP-${id}`,name:'合成售后',status:'active',managerUserIds:[actor._id],memberUserIds:[actor._id],
      version:1,currentNodeId:`node-${id}`,currentNodeIndex:0,createdAt:NOW,updatedAt:NOW}
    seed.business_lines.push(line)
    if(kind==='list') continue
    seed.business_nodes.push({_id:line.currentNodeId,businessLineId:line._id,workflowMode:'review',status:'in_progress',
      processorUserIds:[actor._id],reviewerUserIds:['another-reviewer'],processingRoundNumber:1,version:1,
      processingDueAt:NOW,updatedAt:NOW,name:'合成处理节点',sequence:0,fieldDefinitions:[],requiresEvidence:false,allowedEvidenceTypes:[],
      processingDueStatus:'calculated',reviewDueStatus:'not_started'})
    const reviewLine={...line,_id:`review-line-${id}`,code:`CAP-R-${id}`,currentNodeId:`review-node-${id}`}
    seed.business_lines.push(reviewLine)
    seed.business_nodes.push({_id:reviewLine.currentNodeId,businessLineId:reviewLine._id,sequence:0,workflowMode:'review',
      processorUserIds:['another-processor'],reviewerUserIds:[actor._id],reviewMode:'all',processingRoundNumber:1,reviewRoundNumber:1,
      version:2,status:'pending_review',activeReviewRoundId:`round-${id}`})
    seed.node_review_rounds.push({_id:`round-${id}`,businessLineId:reviewLine._id,nodeId:reviewLine.currentNodeId,
      reviewerUserIds:[actor._id],reviewMode:'all',processingRoundNumber:1,reviewRoundNumber:1,status:'pending',lockedNodeVersion:2,createdAt:NOW})
    seed.notifications.push({_id:`note-${id}`,type:'review_started',recipientUserIds:[actor._id],
      readByUserIds:i<count*readPercent/100?[actor._id]:[],createdAt:NOW})
  }
  return {seed,actor,input:{actor}}
}
module.exports={createWorkspaceFixture}
