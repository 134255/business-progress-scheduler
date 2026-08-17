function safeCell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  text = text.replace(/\r\n|\r|\n/g, '\r\n')
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows, columns) {
  if (!Array.isArray(rows) || !Array.isArray(columns) ||
      columns.some(column => !Array.isArray(column) || column.length !== 2)) {
    throw new TypeError('rows and columns are required')
  }
  const lines = [columns.map(column => safeCell(column[1])).join(',')]
  for (const row of rows) lines.push(columns.map(column => safeCell(row && row[column[0]])).join(','))
  return `\uFEFF${lines.join('\r\n')}`
}

module.exports = { toCsv }
