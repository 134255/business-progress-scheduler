import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FILES = ['operations-field-domain.js', 'field-domain.js', 'conditional-field-domain.js', 'option-linkage-domain.js']
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function syncOperationsFieldDomain({ root = defaultRoot, check = false } = {}) {
  const resolvedRoot = path.resolve(root)
  const source = path.join(resolvedRoot, 'cloudfunctions/businessApi/lib')
  const destination = path.join(resolvedRoot, 'cloudfunctions/operationsAnalytics/lib')
  const mismatches = []
  if (!check) await mkdir(destination, { recursive: true })
  for (const name of FILES) {
    if (!check) {
      await copyFile(path.join(source, name), path.join(destination, name))
      continue
    }
    const expected = await readFile(path.join(source, name))
    let actual
    try { actual = await readFile(path.join(destination, name)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!actual || !expected.equals(actual)) mismatches.push(name)
  }
  return { files: [...FILES], mismatches }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    let root = defaultRoot, check = false
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--check') check = true
      else if (args[index] === '--root' && args[index + 1] && !args[index + 1].startsWith('--')) root = args[++index]
      else throw new Error('Usage: node tools/sync-operations-field-domain.mjs [--check] [--root directory]')
    }
    const result = await syncOperationsFieldDomain({ root, check })
    if (result.mismatches.length) {
      console.error(`Field bundle out of sync: ${result.mismatches.join(', ')}`)
      process.exitCode = 1
    } else console.log(`Field bundle ${check ? 'matches' : 'synchronized'} (${FILES.length} files).`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
