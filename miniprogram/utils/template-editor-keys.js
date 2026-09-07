function createKeyAllocator(occupiedKeys = []) {
  const occupied = new Set(occupiedKeys.filter(key => typeof key === 'string' && key))
  let sequence = 0
  return function allocateKey(prefix) {
    let key
    do {
      sequence += 1
      key = `${prefix}-ui-${sequence}`
    } while (occupied.has(key))
    occupied.add(key)
    return key
  }
}

module.exports = { createKeyAllocator }
