const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '../../..')

test('部署手册包含售后检索集合、索引、双函数密钥和空触发器契约', () => {
  const document = fs.readFileSync(
    path.join(repositoryRoot, 'docs/deployment/template-node-fields-setup.md'),
    'utf8'
  )
  for (const required of [
    'business_search_documents',
    'business_search_requests',
    'BUSINESS_SEARCH_HMAC_SECRET',
    'businessSearch',
    '"triggers": []',
    'documentType ASC, tokenHashes ASC, businessLineId ASC',
    'documentType ASC, businessLineId ASC, generationId ASC, entryId ASC',
    'searchIndexStatus ASC, updatedAt ASC, _id ASC'
  ]) assert.match(document, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
