'use strict'

const { validateFieldValues } = require('../../lib/field-domain')

// Synthetic persisted shapes, not client submissions. See feedback-service's
// fieldSnapshots, cloud-feedback-repository's publish, and review submit/vote.
function fieldSource({ nodeId = 'node-1', values, reviewed = false, ...overrides } = {}) {
  const completedAt = new Date('2026-09-10T16:30:00.000Z')
  const definitions = [
    { fieldKey: 'choice', name: '单选', type: 'single_select', constraints: { options: ['A', 'B'] } },
    { fieldKey: 'tags', name: '多选', type: 'multi_select', constraints: { options: ['X', 'Y', 'Z'] } },
    { fieldKey: 'amount', name: '数量', type: 'number', constraints: {} },
    { fieldKey: 'confirmed', name: '确认', type: 'boolean', constraints: {} },
    { fieldKey: 'short-note', name: '短说明', type: 'short_text', constraints: {} },
    { fieldKey: 'note', name: '说明', type: 'long_text', constraints: {} },
    { fieldKey: 'date', name: '日期', type: 'date', constraints: {} }
  ].map((field, sequence) => ({ ...field, sequence, required: false, description: '' }))
  const line = {
    _id: 'line-1', code: '20260910-0001', name: '合成模板-20260910-0001',
    description: '', plannedStartDate: '', plannedEndDate: '',
    sourceTemplateId: 'template-1', sourceTemplateVersion: 1,
    status: 'active', version: 4, nodeCount: 2, progress: 0,
    flowSchemaVersion: 2, entryNodeId: nodeId, traversedNodeIds: [nodeId],
    routeDecisionVersion: 1, awaitingManualDecision: false,
    currentNodeId: 'next-node', currentNodeIndex: 1, currentNodeName: '后续节点',
    createdBy: 'processor-1', managerUserIds: ['processor-1'],
    memberUserIds: ['processor-1', 'processor-2', 'reviewer-1', 'reviewer-2'],
    optionalTailState: 'none', createdAt: new Date('2026-09-10T01:00:00.000Z'),
    updatedAt: completedAt, ...overrides.line
  }
  const node = {
    _id: nodeId, businessLineId: line._id, sourceTemplateNodeKey: 'stable-node-1',
    nodeKey: 'stable-node-1', nodeCode: `${line.code}-01`, name: '合成节点', sequence: 0,
    status: 'completed', version: reviewed ? 5 : 3, completedAt,
    workflowMode: 'review', routeState: 'completed',
    next: { mode: 'default', targetNodeId: 'next-node' }, activationMode: 'required',
    processorUserIds: ['processor-1', 'processor-2'],
    reviewerUserIds: reviewed ? ['reviewer-1', 'reviewer-2'] : [],
    processorDisplayNames: ['合成处理人一', '合成处理人二'],
    reviewerDisplayNames: reviewed ? ['合成审核人一', '合成审核人二'] : [],
    processorAssignmentMode: 'fixed_accounts', reviewerAssignmentMode: 'fixed_accounts', reviewMode: 'any',
    processingRoundNumber: 1, reviewRoundNumber: reviewed ? 1 : 0,
    ...(reviewed ? { lastReviewRoundId: `round-${nodeId}` } : {}),
    latestFeedbackId: `feedback-${nodeId}`, latestFeedbackRevision: 2,
    fieldDefinitions: definitions, requiresEvidence: false, allowedEvidenceTypes: [],
    processingSlaWorkHours: 22, reviewSlaWorkHours: 22,
    processingStartedAt: new Date('2026-09-10T01:00:00.000Z'),
    processingTimingStatus: 'pending_calendar', processingCalendarVersion: null,
    processingElapsedWorkMinutes: 0, analyticsSnapshotStatus: 'pending',
    analyticsSourceVersion: 1, analyticsCompletedAt: completedAt,
    createdAt: new Date('2026-09-10T01:00:00.000Z'), updatedAt: completedAt,
    ...overrides.node
  }
  const fieldValues = validateFieldValues(node.fieldDefinitions, values === undefined ? [
    { fieldKey: 'choice', value: 'A' }, { fieldKey: 'tags', value: ['X', 'Y'] },
    { fieldKey: 'amount', value: 0 }, { fieldKey: 'confirmed', value: false },
    { fieldKey: 'short-note', value: '简短说明' }, { fieldKey: 'note', value: '完整说明' },
    { fieldKey: 'date', value: '2026-09-10' }
  ] : values)
  const feedback = {
    _id: node.latestFeedbackId, businessLineId: line._id, nodeId,
    nodeCode: node.nodeCode, nodeName: node.name, submittedBy: 'processor-1',
    revision: node.latestFeedbackRevision, plannedRevision: node.latestFeedbackRevision,
    publishState: 'published', status: reviewed ? 'in_progress' : 'completed',
    action: reviewed ? 'save_progress' : 'complete_node',
    processingRoundNumber: node.processingRoundNumber, blockedReason: '',
    fieldValues: structuredClone(fieldValues), comment: '合成处理说明',
    evidenceCount: 0, evidenceTotalBytes: 0, claimedCount: 0, claimedBytes: 0,
    expectedNodeVersion: 2, completionTransition: reviewed ? 'none' : 'next_node',
    freezesLine: false, ...(reviewed ? {} : { nextNodeId: 'next-node', optionalTailState: 'none' }),
    lineStatus: 'active', resultNodeStatus: reviewed ? 'in_progress' : 'completed',
    nodeVersion: reviewed ? 3 : node.version, submittedAt: completedAt,
    transitionAt: completedAt, createdAt: completedAt, updatedAt: completedAt,
    ...overrides.feedback
  }
  const round = reviewed ? {
    _id: node.lastReviewRoundId, businessLineId: line._id, nodeId,
    nodeCode: node.nodeCode, nodeName: node.name,
    processingRoundNumber: node.processingRoundNumber, reviewRoundNumber: node.reviewRoundNumber,
    reviewMode: node.reviewMode, reviewerUserIds: [...node.reviewerUserIds],
    processorDisplayNames: [...node.processorDisplayNames], reviewerDisplayNames: [...node.reviewerDisplayNames],
    feedbackId: feedback._id, feedbackRevision: feedback.revision,
    fieldValues: structuredClone(fieldValues), processingComment: feedback.comment,
    evidenceIds: [], evidenceTotalBytes: 0, status: 'approved', finalDecision: 'approved',
    submittedBy: 'processor-2', submittedByDisplayName: '合成处理人二',
    processorAssignmentMode: 'fixed_accounts', submittedNodeVersion: 3, lockedNodeVersion: 4,
    finalActorId: 'reviewer-1', approvedVoteCount: 1, voteCount: 1,
    resultNodeStatus: 'completed', resultLineStatus: 'active', resultNextNodeId: 'next-node',
    processingTimingStatus: 'pending_calendar', processingRoundTimingStatus: 'pending_calendar',
    processingRoundWorkMinutes: null, processingRoundCalendarVersion: null,
    processingRoundStartedAt: node.processingStartedAt, processingRoundEndedAt: completedAt,
    reviewTimingStatus: 'pending_calendar', reviewStartedAt: completedAt,
    decidedAt: completedAt, version: 2, createdAt: completedAt, updatedAt: completedAt,
    ...overrides.round
  } : null
  const votes = reviewed ? [{
    _id: `vote-${nodeId}`, reviewRoundId: round._id, businessLineId: line._id, nodeId,
    reviewerUserId: 'reviewer-1', reviewerDisplayName: '合成审核人一', decision: 'approved',
    comment: '', expectedRoundVersion: 1, reviewResponseTimingStatus: 'pending_calendar',
    reviewResponseWorkMinutes: null, reviewResponseCalendarVersion: null,
    reviewResponseStartedAt: completedAt, reviewResponseEndedAt: completedAt, createdAt: completedAt
  }] : []
  return { line, node, feedback, round, votes: overrides.votes === undefined ? votes : overrides.votes }
}

module.exports = { fieldSource }
