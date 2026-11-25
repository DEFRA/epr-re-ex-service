const SCANNED_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions'
]

const walk = (entries, section, path) =>
  entries.flatMap(([name, value]) => {
    const qualifiedName = path ? `${path} > ${name}` : name
    if (value && typeof value === 'object') {
      return walk(Object.entries(value), section, qualifiedName)
    }
    return typeof value === 'string' && /^[\^~]/.test(value)
      ? [{ section, name: qualifiedName, range: value }]
      : []
  })

export const findUnpinned = (pkg) =>
  SCANNED_SECTIONS.flatMap((section) =>
    walk(Object.entries(pkg[section] ?? {}), section, '')
  )

export const scanFiles = async (paths, readFile) => {
  const offenders = []
  for (const path of paths) {
    const pkg = JSON.parse(await readFile(path))
    for (const o of findUnpinned(pkg)) {
      offenders.push({ file: path, ...o })
    }
  }
  return offenders
}

const isRunAsScript = () => import.meta.url === `file://${process.argv[1]}`

if (isRunAsScript()) {
  const { readFile } = await import('node:fs/promises')
  const paths = process.argv.slice(2)
  const offenders = await scanFiles(paths, (p) => readFile(p, 'utf8'))
  if (offenders.length > 0) {
    console.error('Unpinned dependency versions found:')
    for (const o of offenders) {
      console.error(`  ${o.file}: ${o.section}.${o.name} -> ${o.range}`)
    }
    console.error(
      '\nAll dependency ranges must be exact versions (e.g. "1.2.3"), not caret/tilde ranges.'
    )
    process.exit(1)
  }
}
