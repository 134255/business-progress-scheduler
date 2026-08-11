const test = require('node:test')
const assert = require('node:assert/strict')

const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

test('a successful-transaction observer runs after commit and cannot roll the transaction back', async () => {
  let transactionErrorObserved = false
  const fake = createFakeCloudDatabase({ records: [{ _id: 'record-1', value: 'before' }] }, {
    afterTransaction: async () => {
      throw new Error('observer failed')
    },
    afterTransactionError: async () => {
      transactionErrorObserved = true
    }
  })

  await assert.rejects(
    fake.db.runTransaction(async transaction => {
      await transaction.collection('records').doc('record-1').update({ data: { value: 'after' } })
      return 'committed'
    }),
    /observer failed/
  )
  assert.equal(fake.documents('records')[0].value, 'after')
  assert.equal(transactionErrorObserved, false)
})

test('乐观事务回调真实重叠、冲突后重跑并保留两次原子增量', async () => {
  const fake = createFakeCloudDatabase({ counters: [{ _id: 'shared', value: 0 }] })
  let arrived = 0
  let release
  const gate = new Promise(resolve => { release = resolve })

  async function increment() {
    return fake.db.runTransaction(async transaction => {
      const current = (await transaction.collection('counters').doc('shared').get()).data
      arrived += 1
      if (arrived === 2) release()
      if (arrived === 1) setTimeout(release, 25)
      if (arrived <= 2) await gate
      await transaction.collection('counters').doc('shared').update({ data: { value: current.value + 1 } })
      return current.value + 1
    })
  }

  await Promise.all([increment(), increment()])

  assert.equal(fake.metrics.maxActiveCallbacks >= 2, true)
  assert.equal(fake.metrics.conflicts >= 1, true)
  assert.equal(fake.metrics.retries >= 1, true)
  assert.equal(fake.documents('counters')[0].value, 2)
})
