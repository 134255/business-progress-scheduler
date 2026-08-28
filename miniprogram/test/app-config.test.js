const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appConfig = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'app.json'), 'utf8')
)

test('does not declare chooseMedia as a requiredPrivateInfos API', () => {
  assert.equal(
    appConfig.requiredPrivateInfos?.includes('chooseMedia') || false,
    false
  )
})
