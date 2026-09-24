'use strict'
// Offline synthetic persisted records. No SDK, credentials, URLs or media allocation.
const {fieldSource} = require('../../cloudfunctions/businessApi/test/helpers/field-fixtures')
const domain = require('../../cloudfunctions/businessApi/lib/operations-field-domain')
const NOW = new Date('2026-09-24T04:00:00.000Z')
const DAY = 86400000
const serial = n => String(n).padStart(6,'0')
const lineId = i => `cap-line-${serial(i)}`
const nodeId = (i,j) => `cap-node-${serial(i)}-${j}`
function demand(value) { if(!value) throw Object.assign(new Error('INVALID_FIXTURE'),{code:'INVALID_FIXTURE'}) }
function createCapacityFixture({days=1,linesPerDay=30,nodesPerLine=5,snapshotMode='missing'}={}) {
  for(const value of [days,linesPerDay,nodesPerLine]) demand(Number.isSafeInteger(value)&&value>=0)
  demand(days>0 && days<=3650 && nodesPerLine>0 && nodesPerLine<=100 && linesPerDay<=10000)
  demand(['missing','valid','stale'].includes(snapshotMode))
  const lineCount=days*linesPerDay
  const actors=['root','processor-1','processor-2','reviewer-1','reviewer-2',
    ...Array.from({length:45},(_,i)=>`cap-member-${String(i).padStart(2,'0')}`)]
    .map(_id=>({_id,role:_id==='root'?'super_admin':'user',status:'active',displayName:'合成成员'}))
  function line(i) {
    // Each day starts at 09:00 Asia/Shanghai; all dates precede the fixed clock.
    const createdAt=new Date(Date.UTC(2026,8,24,1)-DAY*(days-Math.floor(i/linesPerDay)))
    const completedAt=new Date(+createdAt+nodesPerLine*60000)
    const ids=Array.from({length:nodesPerLine},(_,j)=>nodeId(i,j))
    return {_id:lineId(i),code:`CAP-${serial(i)}`,name:'合成售后',description:'',
      sourceTemplateId:'template-1',sourceTemplateVersion:1,status:'completed',version:10,
      nodeCount:nodesPerLine,progress:nodesPerLine,flowSchemaVersion:2,entryNodeId:ids[0],
      traversedNodeIds:ids,currentNodeId:ids.at(-1),currentNodeIndex:nodesPerLine-1,
      currentNodeName:'合成节点',routeDecisionVersion:1,awaitingManualDecision:false,optionalTailState:'none',
      managerUserIds:['root'],memberUserIds:[...actors.slice(1,5).map(a=>a._id),actors[5+i%45]._id],
      createdBy:'processor-1',createdAt,updatedAt:completedAt,completedAt,purgeDueAt:new Date(+completedAt+60*DAY)}
  }
  function source(i,j) {
    const l=line(i),at=new Date(+l.createdAt+(j+1)*60000)
    return fieldSource({nodeId:nodeId(i,j),line:l,
      node:{sequence:j,sourceTemplateNodeKey:`stable-node-${j}`,nodeKey:`stable-node-${j}`,
        nodeCode:`${l.code}-N${j}`,name:`合成节点${j}`,completedAt:at,analyticsCompletedAt:at,
        createdAt:l.createdAt,updatedAt:at,processingStartedAt:l.createdAt,
        next:{mode:'default',targetNodeId:j+1<nodesPerLine?nodeId(i,j+1):''}},
      feedback:{submittedAt:at,transitionAt:at,createdAt:at,updatedAt:at,
        lineStatus:j+1===nodesPerLine?'completed':'active',
        nextNodeId:j+1<nodesPerLine?nodeId(i,j+1):'',completionTransition:j+1===nodesPerLine?'complete_line':'next_node'}})
  }
  function get(collection,id) {
    if(collection==='users') return structuredClone(actors.find(a=>a._id===id))
    if(collection==='business_lines') {
      const m=/^cap-line-(\d{6})$/.exec(id)
      return m && +m[1]<lineCount ? line(+m[1]) : undefined
    }
    const m=/^(?:feedback-)?cap-node-(\d{6})-(\d+)$/.exec(id)
    if(!m || +m[1]>=lineCount || +m[2]>=nodesPerLine) return undefined
    if(collection==='node_feedback' && !id.startsWith('feedback-')) return undefined
    if(collection!=='node_feedback' && id.startsWith('feedback-')) return undefined
    if(!['business_nodes','node_feedback','operations_field_snapshots'].includes(collection)) return undefined
    if(collection==='operations_field_snapshots' && snapshotMode==='missing') return undefined
    const s=source(+m[1],+m[2])
    if(collection==='business_nodes') return s.node
    if(collection==='node_feedback') return s.feedback
    const snapshot=domain.selectionSnapshot(domain.buildFinalFieldResult(s))
    if(snapshotMode==='stale') snapshot.sourceHeader='0'.repeat(64)
    return {_id:id,...snapshot}
  }
  function* entries(collection) {
    if(collection==='users') {for(const actor of actors) yield structuredClone(actor);return}
    if(collection==='business_lines') {for(let i=0;i<lineCount;i++) yield line(i);return}
    if(!['business_nodes','node_feedback','operations_field_snapshots'].includes(collection)) return
    if(collection==='operations_field_snapshots' && snapshotMode==='missing') return
    for(let i=0;i<lineCount;i++) for(let j=0;j<nodesPerLine;j++)
      yield get(collection,`${collection==='node_feedback'?'feedback-':''}${nodeId(i,j)}`)
  }
  return {metadata:{days,lineCount,completedNodeCount:lineCount*nodesPerLine,mediaBytesPerLine:100000000},
    actors:structuredClone(actors),collections:['users','business_lines','business_nodes','node_feedback','operations_field_snapshots'],get,entries}
}
function createProductSource({rowCount=2495}={}) {
  demand(Number.isInteger(rowCount)&&rowCount>0&&rowCount<=2500)
  const fieldKeys=['category','brand','model','color','material','size','style','extra']
  const options=[4,5,125,2,1,1,1,1].map((n,col)=>Array.from({length:n},(_,i)=>`合成${col}-${i}`))
  const rows=Array.from({length:rowCount},(_,i)=>[Math.floor(i/625),Math.floor(i/125)%5,i%125,i%2,null,null,null,null])
  const definitions=fieldKeys.map((fieldKey,i)=>({fieldKey,name:fieldKey,sequence:i,type:'single_select',
    required:false,constraints:{options:options[i]},...(i?{}:{optionLinkage:{schemaVersion:1,fieldKeys,rows}})}))
  return fieldSource({node:{fieldDefinitions:definitions},values:fieldKeys.slice(0,4).map((fieldKey,i)=>({fieldKey,value:options[i][0]}))})
}
module.exports={NOW,createCapacityFixture,createProductSource}
