// Group only request-local reads. Each transaction reauthorizes the account and
// line before checking at most 20 nodes: 22 fixed-document reads in total.
function groupNodeReads(items, lineIdFor) {
  const lines = new Map()
  for (const item of items) {
    const lineId = lineIdFor(item)
    let batches = lines.get(lineId)
    if (!batches) { batches = []; lines.set(lineId, batches) }
    if (!batches.length || batches[batches.length - 1].length === 20) batches.push([])
    batches[batches.length - 1].push(item)
  }
  return [...lines.values()].flat()
}

module.exports = { groupNodeReads }
