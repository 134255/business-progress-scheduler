import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createFakeCloudDatabase } = require('../cloudfunctions/businessApi/test/helpers/fake-cloud-database');

async function withRuntime(run) {
  const syntheticBinding = 'wx-card-lifecycle-synthetic';
  const actor = { _id: 'card-admin', status: 'active', role: 'super_admin',
    username: 'synthetic-admin', displayName: '合成管理员', openid: syntheticBinding };
  const fake = createFakeCloudDatabase({
    users: [actor],
    wechat_bindings: [{ _id: crypto.createHash('sha256').update(syntheticBinding).digest('hex'), userId: actor._id }],
    user_credentials: [{ _id: actor._id, mustChangePassword: false, lockedUntil: null }],
    system_settings: [{ _id: 'account_admin_state', activeSuperAdminCount: 1, revision: 0 }]
  });
  const entry = require.resolve('../cloudfunctions/businessApi/index');
  const oldEntry = require.cache[entry];
  const originalLoad = Module._load;
  const priorSecret = process.env.BUSINESS_SEARCH_HMAC_SECRET;
  try {
    delete process.env.BUSINESS_SEARCH_HMAC_SECRET;
    delete require.cache[entry];
    Module._load = function externalBoundary(request, parent, isMain) {
      if (request === 'wx-server-sdk') return {
        DYNAMIC_CURRENT_ENV: 'synthetic-env', init() {}, database: () => fake.db,
        getWXContext: () => ({ OPENID: syntheticBinding, ENV: 'synthetic-env', REQUESTID: 'synthetic-card-run' }),
        async callFunction() { throw new Error('Unexpected external function call'); },
        async downloadFile() { throw new Error('Unexpected storage download'); },
        async getTempFileURL() { throw new Error('Unexpected storage URL request'); }
      };
      return originalLoad.call(this, request, parent, isMain);
    };
    const { main } = require(entry);
    const call = async (action, payload = {}) => {
      const response = await main({ action, payload });
      assert.equal(response.ok, true, `${action}: ${response.code || ''}`);
      return response.data;
    };
    await run({ fake, call, actor });
  } finally {
    Module._load = originalLoad;
    delete require.cache[entry];
    if (oldEntry) require.cache[entry] = oldEntry;
    if (priorSecret === undefined) delete process.env.BUSINESS_SEARCH_HMAC_SECRET;
    else process.env.BUSINESS_SEARCH_HMAC_SECRET = priorSecret;
  }
}

async function createCase({ call, fake, actor }) {
  const definition = await call('createTemplate', {
    name: '合成卡片模板', description: '', nodes: [{
      sequence: 0, name: '合成处理节点', description: '', workflowMode: 'review',
      processorAssignmentMode: 'fixed_accounts', processorUserIds: [actor._id],
      reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: [], reviewMode: 'any',
      processingSlaWorkHours: 8, reviewSlaWorkHours: 8,
      requiresEvidence: false, allowedEvidenceTypes: [], fields: [
        { sequence: 0, name: '型号', type: 'short_text', required: false, constraints: {} },
        { sequence: 1, name: '数量', type: 'number', required: false, constraints: {} },
        { sequence: 2, name: '确认', type: 'boolean', required: false, constraints: {} }
      ]
    }]
  });
  const template = definition.template;
  await call('changeTemplateStatus', { templateId: template._id, expectedVersion: template.version, status: 'enabled' });
  const business = await call('createBusinessFromTemplate', { templateId: template._id, requestKey: 'synthetic-create' });
  const node = fake.documents('business_nodes').find(item => item.businessLineId === business.id);
  assert.ok(node);
  return { templateId: template._id, businessLineId: business.id, node,
    selected: definition.nodes[0].fields.map(field => ({ nodeKey: definition.nodes[0].nodeKey, fieldKey: field.fieldKey })) };
}

async function progress(context, created, action, values, requestKey) {
  const node = context.fake.documents('business_nodes').find(item => item._id === created.node._id);
  return context.call('submitFeedback', { businessLineId: created.businessLineId, nodeId: node._id,
    expectedNodeVersion: node.version, action, comment: '', evidenceIds: [], requestKey,
    fieldValues: node.fieldDefinitions.map((field, index) => ({ fieldKey: field.fieldKey, value: values[index] })) });
}

test('synthetic default-runtime fixture supports actual template, creation, progress and reviewerless completion', async () => {
  await withRuntime(async context => {
    const created = await createCase(context);
    await progress(context, created, 'save_progress', ['合成初值', 0, false], 'synthetic-progress');
    assert.equal(context.fake.documents('business_nodes')[0].status, 'in_progress');
    await progress(context, created, 'complete_node', ['合成终值', 0, false], 'synthetic-complete');
    assert.equal(context.fake.documents('business_lines')[0].status, 'completed');
  });
});

test('real runtime card config applies to an existing case and its final values without rewriting history', async () => {
  await withRuntime(async context => {
    const created = await createCase(context);
    await progress(context, created, 'save_progress', ['合成初值', 0, false], 'synthetic-progress');
    const templateBefore = context.fake.documents('templates')[0];
    const lineBefore = context.fake.documents('business_lines')[0];
    const saved = await context.call('updateTemplateCardDisplay', { templateId: created.templateId,
      expectedRevision: 0, fields: created.selected });
    assert.equal(saved.revision, 1);
    const list = await context.call('listBusinessLines', { status: 'active', scope: 'mine' });
    const card = list.items.find(item => item._id === created.businessLineId);
    assert.deepEqual(card.cardSummary.fields.map(field => field.value), ['合成初值', '0', '否']);
    for (const key of ['version', 'updatedAt', 'status', 'searchSourceVersion']) {
      assert.deepEqual(context.fake.documents('business_lines')[0][key], lineBefore[key], key);
    }
    for (const key of ['version', 'definitionDigest', 'definitionNodeIds']) {
      assert.deepEqual(context.fake.documents('templates')[0][key], templateBefore[key], key);
    }
    await progress(context, created, 'complete_node', ['合成终值', 0, false], 'synthetic-complete');
    const finished = await context.call('listBusinessLines', { status: 'completed', scope: 'mine' });
    assert.deepEqual(finished.items[0].cardSummary.fields.map(field => field.value), ['合成终值', '0', '否']);
    const historyBefore = context.fake.documents('node_feedback');
    await context.call('updateTemplateCardDisplay', { templateId: created.templateId,
      expectedRevision: 1, fields: [created.selected[2], created.selected[0]] });
    const changed = await context.call('getMyDashboardSummary');
    assert.deepEqual(changed.recent[0].cardSummary.fields.map(field => field.value), ['否', '合成终值']);
    assert.deepEqual(context.fake.documents('node_feedback'), historyBefore);
  });
});
