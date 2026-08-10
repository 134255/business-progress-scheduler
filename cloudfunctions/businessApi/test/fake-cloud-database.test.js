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
