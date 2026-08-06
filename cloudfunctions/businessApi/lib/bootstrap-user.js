function isDuplicateKeyError(error) {
  const details = [
    error && error.code,
    error && error.errCode,
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).join(' ')

  return /E11000|DuplicateKey|duplicate key/i.test(details)
}

async function findUserByOpenid(users, openid) {
  const result = await users.where({ openid }).limit(1).get()
  return result.data[0] || null
}

async function bootstrapUser({ users, openid, now }) {
  const existing = await findUserByOpenid(users, openid)
  if (existing) return existing

  const timestamp = now()
  const user = {
    openid,
    displayName: '微信用户',
    avatarUrl: '',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp
  }

  try {
    const created = await users.add({ data: user })
    return Object.assign({ _id: created._id }, user)
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error

    const winner = await findUserByOpenid(users, openid)
    if (!winner) throw error
    return winner
  }
}

module.exports = {
  bootstrapUser,
  isDuplicateKeyError
}
