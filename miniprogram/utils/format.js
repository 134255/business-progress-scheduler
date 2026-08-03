const STATUS_LABELS = {
  draft: '草稿',
  active: '进行中',
  completed: '已完成',
  blocked: '受阻',
  deleted: '已删除',
  pending: '待开始',
  ready: '待处理',
  in_progress: '处理中'
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '未知'
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

module.exports = { statusLabel, formatDate }

