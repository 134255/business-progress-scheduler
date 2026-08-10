const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudStorageAdapter } = require('../lib/cloud-storage-adapter')

test('云存储删除成功或对象已不存在都返回幂等结果', async () => {
  const success = createCloudStorageAdapter({
    cloud: { deleteFile: async () => ({ fileList: [{ status: 0, errMsg: 'ok' }] }) }
  })
  assert.deepEqual(await success.deleteObject('cloud://env/file'), { absent: false })

  const absent = createCloudStorageAdapter({
    cloud: { deleteFile: async () => { const error = new Error('file not found'); error.errCode = 'FILE_NOT_FOUND'; throw error } }
  })
  assert.deepEqual(await absent.deleteObject('cloud://env/missing'), { absent: true })
})

test('云存储失败只映射安全分类且不透传路径或供应商消息', async () => {
  const adapter = createCloudStorageAdapter({
    cloud: { deleteFile: async () => ({ fileList: [{ status: -1, errMsg: 'secret cloud://env/private' }] }) }
  })
  await assert.rejects(adapter.deleteObject('cloud://env/private'), error => {
    assert.equal(error.category, 'TRANSIENT')
    assert.equal(error.message.includes('cloud://'), false)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})

test('适配器拒绝非云文件编号和畸形响应', async () => {
  const adapter = createCloudStorageAdapter({ cloud: { deleteFile: async () => ({ fileList: [] }) } })
  await assert.rejects(adapter.deleteObject('https://example.com/file'), error => error.category === 'INVALID_RECORD')
  await assert.rejects(adapter.deleteObject('cloud://env/file'), error => error.category === 'TRANSIENT')
})
