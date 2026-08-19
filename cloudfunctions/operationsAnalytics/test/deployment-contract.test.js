const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '../../..')
const deployment = fs.readFileSync(path.join(repositoryRoot, 'docs/deployment/template-node-fields-setup.md'), 'utf8')

test('部署手册声明运营统计集合、严格权限与空触发器', () => {
  assert.match(deployment, /operations_analytics_facts/)
  assert.match(deployment, /operations_analytics_daily/)
  assert.match(deployment, /operationsAnalytics/)
  assert.match(deployment, /operationsAnalytics[^\n]*triggers:\s*\[\]/)
  assert.match(deployment, /仅云函数\/服务端可读写/)
})

test('部署手册索引覆盖工作器候选、事实、汇总与查询排序', () => {
  const requiredIndexes = [
    'name` 升序、`_id` 升序',
    'businessLineId` 升序、`nodeId` 升序、`_id` 升序',
    'analyticsSnapshotStatus` 升序、`_id` 升序',
    'timingStatus` 升序、`_id` 升序',
    'businessLineId` 升序、`sourceType` 升序、`dimensionRole` 升序、`_id` 升序',
    'templateId` 升序、`day` 升序、`_id` 升序',
    'templateId` 升序、`dimensionRole` 升序、`day` 升序、`_id` 升序',
    'templateId` 升序、`dimensionRole` 升序、`dimensionFilterToken` 升序、`day` 升序、`_id` 升序'
  ]
  for (const index of requiredIndexes) assert.ok(deployment.includes(index), `缺少索引：${index}`)
})

test('部署手册要求隔离一次性 Timer、多账号权限和独立批准周期任务', () => {
  assert.match(deployment, /operationsAnalytics[^\n]*一次性 Timer/)
  assert.match(deployment, /普通用户[^\n]*明细[^\n]*权限/)
  assert.match(deployment, /超级管理员[^\n]*全部明细/)
  assert.match(deployment, /15 分钟[^\n]*单独批准/)
})
