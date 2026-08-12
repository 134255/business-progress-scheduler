'use strict'

// CloudBase 公开索引键上限为 1024 字节，但未公开数组/BSON逐字节公式。
// 这里把可见 BSON string-array 编码限制在 768 字节，并同时限制人数，
// 为字段路径、类型标签及平台实现差异预留至少 25% 空间。
const MAX_INDEXED_ACCOUNT_IDS = 50
const MAX_INDEXED_ARRAY_BYTES = 768
const MAX_ACCOUNT_ID_BYTES = 128

function indexedStringArrayBytes(values) {
  if (!Array.isArray(values)) return Number.POSITIVE_INFINITY
  return 5 + values.reduce((total, value, index) => {
    if (typeof value !== 'string') return Number.POSITIVE_INFINITY
    return total + 1 + Buffer.byteLength(String(index), 'utf8') + 1 + 4 +
      Buffer.byteLength(value, 'utf8') + 1
  }, 0)
}

function fitsIndexedAccountArray(values) {
  return Array.isArray(values) && values.length <= MAX_INDEXED_ACCOUNT_IDS &&
    indexedStringArrayBytes(values) <= MAX_INDEXED_ARRAY_BYTES
}

function fitsBusinessMemberArray(participantUserIds) {
  return fitsIndexedAccountArray(['x'.repeat(MAX_ACCOUNT_ID_BYTES), ...participantUserIds])
}

const INDEXED_ACCOUNT_ARRAY_LIMIT_MESSAGE =
  `索引账号数组最多 ${MAX_INDEXED_ACCOUNT_IDS} 人，保守 BSON 预算不超过 ${MAX_INDEXED_ARRAY_BYTES} 字节`

module.exports = {
  INDEXED_ACCOUNT_ARRAY_LIMIT_MESSAGE,
  MAX_INDEXED_ACCOUNT_IDS,
  MAX_INDEXED_ARRAY_BYTES,
  fitsBusinessMemberArray,
  fitsIndexedAccountArray,
  indexedStringArrayBytes
}
