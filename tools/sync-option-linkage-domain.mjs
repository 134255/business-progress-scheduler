import { copyFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'cloudfunctions/businessApi/lib/option-linkage-domain.js')
const destination = path.join(root, 'miniprogram/utils/option-linkage-domain.js')
if (process.argv.includes('--check')) {
  const [expected, actual] = await Promise.all([readFile(source), readFile(destination)])
  if (!expected.equals(actual)) throw new Error('Client linkage domain is out of sync')
  console.log('Client linkage domain matches.')
} else {
  await copyFile(source, destination)
  console.log('Client linkage domain synchronized.')
}
