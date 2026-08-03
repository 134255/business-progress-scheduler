const { statusLabel } = require('../../utils/format')

Component({
  properties: {
    status: { type: String, value: 'pending' }
  },
  data: { label: '待开始' },
  observers: {
    status(value) {
      this.setData({ label: statusLabel(value) })
    }
  }
})

