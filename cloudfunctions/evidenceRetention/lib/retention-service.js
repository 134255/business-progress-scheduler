'use strict'

const SAFE_ERROR_CATEGORY = /^[A-Z][A-Z0-9_]{0,31}$/

function requireMethod(target, name) {
  if (!target || typeof target[name] !== 'function') {
    throw new TypeError(`${name} is required`)
  }
  return target[name].bind(target)
}

function safeCategory(error) {
  const value = error && error.category
  return typeof value === 'string' && SAFE_ERROR_CATEGORY.test(value) ? value : 'UNKNOWN'
}

function createRetentionService({ repository, storage, clock = () => new Date(), batchSize = 50 } = {}) {
  if (!repository || typeof repository !== 'object') throw new TypeError('repository is required')
  if (!storage || typeof storage !== 'object') throw new TypeError('storage is required')
  if (typeof clock !== 'function') throw new TypeError('clock is required')
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new TypeError('batchSize must be an integer from 1 to 100')
  }

  function recordFailure(failures, error) {
    const category = safeCategory(error)
    failures[category] = (failures[category] || 0) + 1
  }

  async function scan({ list, handle, now, failures }) {
    let completed = 0
    const page = await list({ now, limit: batchSize })
    if (!Array.isArray(page)) throw new TypeError('repository page must be an array')
    for (const candidate of page) {
      const id = typeof candidate === 'string' ? candidate : candidate && candidate.evidenceId
      if (typeof id !== 'string' || !id) {
        recordFailure(failures, { category: 'INVALID_RECORD' })
        continue
      }
      try {
        if (await handle(candidate, id)) completed += 1
      } catch (error) {
        recordFailure(failures, error)
      }
    }
    return completed
  }

  async function recoverReservations({ listName, recoverName, now, failures }) {
    const list = requireMethod(repository, listName)
    const recover = requireMethod(repository, recoverName)
    return scan({
      list,
      now,
      failures,
      handle: async (_candidate, id) => Boolean(await recover({ id, now }))
    })
  }

  async function purgeCandidates({ listName, mode, now, failures }) {
    const list = requireMethod(repository, listName)
    const claim = requireMethod(repository, 'claimEvidenceForPurge')
    const markPurged = requireMethod(repository, 'markEvidencePurged')
    const markFailed = requireMethod(repository, 'markEvidencePurgeFailed')
    const deleteObject = requireMethod(storage, 'deleteObject')
    return scan({
      list,
      now,
      failures,
      handle: async (_candidate, evidenceId) => {
        const claimed = await claim({ evidenceId, mode, now })
        if (!claimed) return false
        if (typeof claimed.fileId !== 'string' || !claimed.fileId ||
            typeof claimed.claimToken !== 'string' || !claimed.claimToken) {
          const error = { category: 'INVALID_RECORD' }
          await markFailed({ evidenceId, mode, now, errorCategory: error.category })
          throw error
        }
        try {
          const deletion = await deleteObject(claimed.fileId)
          await markPurged({
            evidenceId,
            mode,
            now,
            claimToken: claimed.claimToken,
            objectWasAbsent: Boolean(deletion && deletion.absent)
          })
          return true
        } catch (error) {
          const errorCategory = safeCategory(error)
          try {
            await markFailed({ evidenceId, mode, now, claimToken: claimed.claimToken, errorCategory })
          } catch (markError) {
            markError.category = safeCategory(markError)
            throw markError
          }
          throw { category: errorCategory }
        }
      }
    })
  }

  async function runOnce() {
    const now = clock()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid Date')
    const failures = {}
    const feedbackReservationsRecovered = await recoverReservations({
      listName: 'listExpiredFeedbackReservations',
      recoverName: 'recoverExpiredFeedbackReservation',
      now,
      failures
    })
    const amendmentReservationsRecovered = await recoverReservations({
      listName: 'listExpiredAmendmentReservations',
      recoverName: 'recoverExpiredAmendmentReservation',
      now,
      failures
    })
    const orphansPurged = await purgeCandidates({
      listName: 'listExpiredOrphans',
      mode: 'orphan',
      now,
      failures
    })
    const createDueReminders = requireMethod(repository, 'createDueReminders')
    const remindersCreated = await createDueReminders({ now, limit: batchSize })
    if (!Number.isSafeInteger(remindersCreated) || remindersCreated < 0) {
      throw new TypeError('remindersCreated must be a non-negative safe integer')
    }
    const objectsPurged = await purgeCandidates({
      listName: 'listDueEvidence',
      mode: 'retention',
      now,
      failures
    })
    return {
      feedbackReservationsRecovered,
      amendmentReservationsRecovered,
      remindersCreated,
      objectsPurged,
      orphansPurged,
      failures
    }
  }

  return { runOnce }
}

module.exports = { createRetentionService }
