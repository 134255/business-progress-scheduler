const crypto = require('node:crypto')
const { ownExactAccountIds } = require('./account-relationship-schema')
const { boundedMap } = require('./bounded-map')
const { fieldError } = require('./operations-field-service')
const { createOperationsReportCursor } = require('./operations-report-cursor')
const domain = require('./operations-field-domain')

const MAX_NODES = 2000
const MAX_LINES = 5000
const MAX_SCAN = 10000
const MAX_REPORT_ROWS = 50000
const MAX_REPORT_BYTES = 12 * 1024 * 1024
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stable = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(stable) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])])) : value
const fingerprint = value => digest(stable(value))
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)

function createCloudOperationsFieldRepository({ db, operationsRepository, secret, clock = () => new Date() }) {
  if (!db) throw new TypeError('db is required')
  const reports = new Map()
  async function read(database, collection, id) {
    if (!idValid(id)) throw fieldError('FIELD_SOURCE_INVALID')
    try { return (await database.collection(collection).doc(id).get()).data || null } catch (error) {
      if (/document\.get:fail.*does not exist/i.test(String(error && error.message || ''))) return null
      throw error
    }
  }
  async function actorNow(actor, database = db, adminOnly = false) {
    if (!actor || !idValid(actor._id)) throw fieldError('FORBIDDEN')
    const current = await read(database, 'users', actor._id)
    if (!current || current.status !== 'active' || !['user','super_admin'].includes(current.role) ||
        adminOnly && current.role !== 'super_admin') throw fieldError('FORBIDDEN')
    return current
  }
  function canRead(actor, line) {
    if (!line) return false
    if (actor.role === 'super_admin') return true
    const managers = ownExactAccountIds(line,'managerUserIds',{nonEmpty:true})
    const members = ownExactAccountIds(line,'memberUserIds',{nonEmpty:true})
    return Boolean(managers && members && (managers.includes(actor._id) || members.includes(actor._id)))
  }
  async function scan(collection, criteria, max) {
    const rows = []
    let after = ''
    while (rows.length <= max) {
      const size = Math.min(100,max+1-rows.length)
      if (size <= 0) break
      const result = await db.collection(collection).where({...criteria,...(after ? {_id:db.command.gt(after)} : {})})
        .orderBy('_id','asc').limit(size).get()
      const page = result.data
      if (!Array.isArray(page) || page.some(item=>!item || !idValid(item._id))) throw fieldError('FIELD_SOURCE_INVALID')
      rows.push(...page)
      if (page.length < size) break
      const next = page[page.length-1]._id
      if (after && next <= after) throw fieldError('FIELD_SOURCE_INVALID')
      after = next
    }
    if (rows.length > max) throw fieldError('RANGE_TOO_LARGE')
    return rows
  }
  const lineIdentity = line => fingerprint({
    _id:line._id,roleManagers:line.managerUserIds,roleMembers:line.memberUserIds,status:line.status,
    sourceTemplateId:line.sourceTemplateId,sourceTemplateVersion:line.sourceTemplateVersion,
    code:line.code,name:line.name,createdAt:line.createdAt,flowSchemaVersion:line.flowSchemaVersion,
    traversedNodeIds:line.traversedNodeIds,currentNodeId:line.currentNodeId
  })
  async function authorizedLines(actor, range) {
    const current = await actorNow(actor)
    if (range.businessLineId) {
      const line = await read(db,'business_lines',range.businessLineId)
      if (!canRead(current,line)) throw fieldError('FORBIDDEN')
      return {current,lines:[line]}
    }
    const template = range.templateId ? {sourceTemplateId:range.templateId} : {}
    const rows = current.role === 'super_admin' ? await scan('business_lines',template,MAX_LINES) :
      [...await scan('business_lines',{...template,memberUserIds:current._id},MAX_LINES),
        ...await scan('business_lines',{...template,managerUserIds:current._id},MAX_LINES)]
    const lines = [...new Map(rows.filter(line=>canRead(current,line)).map(line=>[line._id,line])).values()]
    if (lines.length > MAX_LINES) throw fieldError('RANGE_TOO_LARGE')
    return {current,lines}
  }
  async function reauthorize(actor, expectedActor, lines, adminOnly = false) {
    await actorNow(actor,db,adminOnly)
    await boundedMap(lines,line=>db.runTransaction(async tx=>{
      const current = await actorNow(actor,tx,adminOnly)
      if (current.role !== expectedActor.role) throw fieldError('FORBIDDEN')
      const fresh = await read(tx,'business_lines',line._id)
      if (!canRead(current,fresh)) throw fieldError('FORBIDDEN')
      if (lineIdentity(fresh) !== lineIdentity(line)) throw fieldError('REPORT_CHANGED')
    }),4)
    const current = await actorNow(actor,db,adminOnly)
    if (current.role !== expectedActor.role) throw fieldError('FORBIDDEN')
  }
  async function readSource(line,node) {
    const feedback = node.latestFeedbackId ? await read(db,'node_feedback',node.latestFeedbackId) : null
    const round = node.lastReviewRoundId ? await read(db,'node_review_rounds',node.lastReviewRoundId) : null
    const votes = round ? await scan('node_review_votes',{reviewRoundId:round._id},50) : []
    return {line,node,feedback,round,votes}
  }
  async function finalResult(actor, source, result, adminOnly, publish = false) {
    return db.runTransaction(async tx=>{
      const current = await actorNow(actor,tx,adminOnly)
      const line = await read(tx,'business_lines',source.line._id)
      if (!canRead(current,line)) throw fieldError('FORBIDDEN')
      const node = await read(tx,'business_nodes',source.node._id)
      if (!node) throw fieldError('REPORT_CHANGED')
      const feedback = source.feedback ? await read(tx,'node_feedback',source.feedback._id) : null
      const round = source.round ? await read(tx,'node_review_rounds',source.round._id) : null
      const votes = []
      for (const vote of source.votes) votes.push(await read(tx,'node_review_votes',vote._id))
      const fresh = domain.buildFinalFieldResult({line,node,feedback,round,votes})
      if (!fresh || fresh.sourceDigest !== result.sourceDigest) throw fieldError('REPORT_CHANGED')
      if (publish) await tx.collection('operations_field_snapshots').doc(node._id).set({data:domain.selectionSnapshot(fresh)})
      return fresh
    })
  }
  function cachedSelection(snapshot,line,node) {
    if (!snapshot || snapshot.nodeId !== node._id || snapshot.businessLineId !== line._id ||
        snapshot.sourceHeader !== domain.fieldSourceHeader({line,node}) || snapshot.businessCode !== line.code ||
        snapshot.businessName !== line.name || snapshot.businessStatus !== line.status ||
        snapshot.nodeName !== node.name || snapshot.nodeSequence !== node.sequence || snapshot.nodeCode !== node.nodeCode) return null
    try {
      const selection = domain.selectionSnapshot(snapshot)
      if (snapshot.fields.length !== selection.fields.length) return null
      return selection
    } catch (_) { return null }
  }
  async function readCachedSelection(actor,line,node) {
    const snapshot = await read(db,'operations_field_snapshots',node._id)
    const candidate = cachedSelection(snapshot,line,node)
    if (!candidate) return null
    return db.runTransaction(async tx=>{
      const current = await actorNow(actor,tx)
      const freshLine = await read(tx,'business_lines',line._id)
      if (!canRead(current,freshLine)) throw fieldError('FORBIDDEN')
      const freshNode = await read(tx,'business_nodes',node._id)
      if (!freshNode || !cachedSelection(candidate,freshLine,freshNode)) throw fieldError('REPORT_CHANGED')
      return candidate
    })
  }
  async function refreshAfterMutation({actor,action,payload}) {
    if (!['submitFeedback','saveAndSubmitNodeForReview','submitNodeForReview','submitReviewVote','decideNodeRoute'].includes(action)) return
    await actorNow(actor)
    let nodeId = payload && payload.nodeId
    if (action === 'submitReviewVote') {
      const round = await read(db,'node_review_rounds',payload && payload.reviewRoundId)
      if (!round) return
      nodeId = round.nodeId
    }
    if (!idValid(nodeId)) return
    const node = await read(db,'business_nodes',nodeId)
    if (!node) return
    const line = await read(db,'business_lines',node.businessLineId)
    const current = await actorNow(actor)
    if (!canRead(current,line)) throw fieldError('FORBIDDEN')
    const source = await readSource(line,node)
    const result = domain.buildFinalFieldResult(source)
    if (result) await finalResult(actor,source,result,false,true)
  }
  async function collect(actor, range, { full = false, filters = false } = {}) {
    const selected = await authorizedLines(actor,range)
    const lines = selected.lines.filter(line => !['deleted','creating'].includes(line.status) &&
      (!range.templateId || line.sourceTemplateId === range.templateId) &&
      (range.templateVersion == null || line.sourceTemplateVersion === range.templateVersion) &&
      (!range.status || line.status === range.status))
    const candidates = []
    let scanned = 0, incomplete = false
    for (let offset=0; offset<lines.length; offset+=20) {
      const ids = lines.slice(offset,offset+20).map(line=>line._id)
      for (const status of ['completed','awaiting_decision']) {
        const page = await scan('business_nodes',{businessLineId:db.command.in(ids),status},MAX_SCAN-scanned)
        scanned += page.length
        for (const node of page) {
          if (node.status === 'awaiting_decision' && node.routeState !== 'awaiting_manual_decision') continue
          const line = lines.find(item=>item._id===node.businessLineId)
          if (line && line.flowSchemaVersion === 2 &&
              (['dormant','skipped'].includes(node.routeState) || Array.isArray(line.traversedNodeIds) &&
                !line.traversedNodeIds.includes(node._id) && line.currentNodeId !== node._id)) continue
          if (range.stableNodeId && node.sourceTemplateNodeKey !== range.stableNodeId) continue
          const at = node.completedAt instanceof Date ? node.completedAt : new Date(node.completedAt)
          if (node.completedAt == null || !Number.isFinite(at.getTime())) { incomplete = true; continue }
          if (at < range.startAt || at >= range.endAt) continue
          candidates.push(node)
          if (candidates.length > MAX_NODES) throw fieldError('RANGE_TOO_LARGE')
        }
      }
    }
    const lineMap = new Map(lines.map(line=>[line._id,line]))
    const results = await boundedMap(candidates,async node=>{
      const line = lineMap.get(node.businessLineId)
      try {
        const cached = !full ? await readCachedSelection(actor,line,node) : null
        const source = cached ? null : await readSource(line,node)
        const result = cached || domain.buildFinalFieldResult(source)
        if (!result) return null
        if (range.templateVersion !== null && range.templateVersion !== undefined && result.templateVersion !== range.templateVersion) return null
        if (!filters && (range.processorToken && result.processorToken !== range.processorToken ||
            range.reviewerToken && !result.reviewerTokens.includes(range.reviewerToken))) return null
        const fresh = cached || await finalResult(actor,source,result,full)
        return full ? fresh : domain.selectionSnapshot(fresh)
      } catch (error) {
        if (['FIELD_SOURCE_INVALID','INVALID_FIELD_VALUE'].includes(error && error.code)) { incomplete = true; return null }
        throw error
      }
    },4)
    await reauthorize(actor,selected.current,lines,full)
    return {scope:selected.current.role==='super_admin'?'all':'authorized',results:results.filter(Boolean),incomplete,
      current:selected.current,lines,candidateNodes:filters ? candidates : []}
  }
  async function getSummary({actor,range}) {
    const data = await collect(actor,range)
    return {scope:data.scope,groups:domain.aggregateFieldResults(data.results),sampledNodeCount:data.results.length,incomplete:data.incomplete}
  }
  async function getFilters({actor,range}) {
    const data = await collect(actor,{...range,templateId:'',templateVersion:null,stableNodeId:'',businessLineId:'',status:'',processorToken:'',reviewerToken:''},{filters:true})
    const templates = new Map(), nodes = new Map(),versions=new Set(),businesses=new Map(),processors=new Map(),reviewers=new Map()
    const nodeMap=new Map(data.candidateNodes.map(node=>[node._id,node]))
    function addParticipants(target,node,role,actualTokens) {
      const ids=node[role+'UserIds'] || [],names=node[role+'DisplayNames']
      const validNames=Array.isArray(names) && names.length===ids.length && names.every(name=>
        typeof name==='string' && name.trim() && name.length<=100 && !/[\u0000-\u001f\u007f]/.test(name))
      for(let index=0;index<ids.length;index++) {
        // Same purpose-separated identity as final-result and timing domains.
        const token=crypto.createHash('sha256').update(['operations-filter-v1',role,ids[index]].join('\0')).digest('hex')
        if(!actualTokens.includes(token)) continue
        target.set(token,{token,displayName:validNames ? names[index].trim() : `历史${role==='processor'?'处理人':'审核人'}（${token.slice(0,8)}）`})
      }
    }
    for (const item of data.results) {
      templates.set(item.templateId,{templateId:item.templateId,templateName:item.templateName})
      if (range.templateId && range.templateId !== item.templateId) continue
      versions.add(item.templateVersion)
      nodes.set(item.stableNodeId,{stableNodeId:item.stableNodeId,nodeName:item.nodeName,sequence:item.nodeSequence})
      businesses.set(item.businessLineId,{businessLineId:item.businessLineId,businessCode:item.businessCode,businessName:item.businessName})
      const sourceNode=nodeMap.get(item.nodeId)
      addParticipants(processors,sourceNode,'processor',[item.processorToken])
      addParticipants(reviewers,sourceNode,'reviewer',item.reviewerTokens)
    }
    return {templates:[...templates.values()].sort((a,b)=>a.templateName.localeCompare(b.templateName)),
      templateVersions:[...versions].sort((a,b)=>b-a),stableNodes:[...nodes.values()].sort((a,b)=>a.sequence-b.sequence),
      businesses:[...businesses.values()].sort((a,b)=>a.businessCode.localeCompare(b.businessCode)),
      processors:[...processors.values()].sort((a,b)=>a.displayName.localeCompare(b.displayName)),
      reviewers:[...reviewers.values()].sort((a,b)=>a.displayName.localeCompare(b.displayName)),incomplete:data.incomplete}
  }
  async function exportReportRows({actor,range}) {
    await actorNow(actor,db,true)
    const codec = createOperationsReportCursor({secret,clock})
    const query = {...range}; delete query.cursor; delete query.pageSize
    const queryDigest = fingerprint(query)
    const continuation = range.cursor ? codec.decode(range.cursor,{actorId:actor._id,queryDigest}) : null
    const data = await collect(actor,range,{full:true})
    if (data.incomplete) throw fieldError('INCOMPLETE_FIELD_DATA')
    const sourceManifest = {
      nodes:data.results.map(result=>({nodeId:result.nodeId,sourceDigest:result.sourceDigest,
        labels:fingerprint([result.businessCode,result.businessName,result.businessStatus,result.templateName,
          result.nodeName,result.nodeCode,result.nodeSequence])})).sort((a,b)=>a.nodeId.localeCompare(b.nodeId)),
      lines:data.lines.map(line=>({id:line._id,stamp:lineIdentity(line)})).sort((a,b)=>a.id.localeCompare(b.id))
    }
    const now=clock().getTime()
    for(const [key,value] of reports) if(value.expiresAt<=now) reports.delete(key)
    const prefix=fingerprint([actor._id,queryDigest])
    let report=continuation && reports.get(prefix+continuation.reportDigest)
    if(report) {
      if(fingerprint(report.sourceManifest)!==fingerprint(sourceManifest)) throw fieldError('REPORT_CHANGED')
      await operationsRepository.validateReportBase({actor,range,manifest:report.baseManifest})
    } else {
      const base=await operationsRepository.collectReportBase({actor,range:{...range,cursor:''}})
      if(!base || !Array.isArray(base.items) || !base.manifest) throw fieldError('INCOMPLETE_FIELD_DATA')
      const rows=[...base.items.map(row=>({...row,recordType:'运营基础',dateBasis:'售后创建日期'})),
        ...domain.fieldExportRows(data.results)]
      report={rows,sourceManifest,baseManifest:base.manifest,
        expiresAt:continuation ? continuation.expiresAt : now+20*60*1000}
      report.digest=fingerprint({rows,sourceManifest,baseManifest:base.manifest})
      report.bytes=Buffer.byteLength(JSON.stringify(report))
      if(rows.length>MAX_REPORT_ROWS || report.bytes>MAX_REPORT_BYTES) throw fieldError('RANGE_TOO_LARGE')
    }
    // Base collection/verification can yield while a node's final source changes.
    // Recheck full authoritative source identity and values before releasing any page.
    const lineMap=new Map(data.lines.map(line=>[line._id,line]))
    await boundedMap(data.results,async result=>{
      const node=await read(db,'business_nodes',result.nodeId)
      if(!node) throw fieldError('REPORT_CHANGED')
      const source=await readSource(lineMap.get(result.businessLineId),node)
      try { await finalResult(actor,source,result,true) } catch(error) {
        if(error && error.code==='FIELD_SOURCE_INVALID') throw fieldError('REPORT_CHANGED')
        throw error
      }
    },4)
    await reauthorize(actor,data.current,data.lines,true)
    const reportDigest = report.digest
    if (continuation && continuation.reportDigest !== reportDigest) throw fieldError('REPORT_CHANGED')
    reports.delete(prefix+reportDigest)
    let used=[...reports.values()].reduce((sum,item)=>sum+item.bytes,0)
    while(reports.size && (reports.size>=3 || used+report.bytes>MAX_REPORT_BYTES)) {
      const key=reports.keys().next().value;used-=reports.get(key).bytes;reports.delete(key)
    }
    reports.set(prefix+reportDigest,report)
    const rows=report.rows
    const offset=continuation ? continuation.offset : 0
    if (offset>rows.length) throw fieldError('VALIDATION_ERROR')
    const items=rows.slice(offset,offset+range.pageSize)
    const hasMore=offset+items.length<rows.length
    return {items,hasMore,nextCursor:hasMore ? codec.encode({actorId:actor._id,queryDigest,reportDigest,
      offset:offset+items.length,expiresAt:report.expiresAt}) : ''}
  }
  return {getSummary,getFilters,exportReportRows,refreshAfterMutation}
}
module.exports = {createCloudOperationsFieldRepository}
