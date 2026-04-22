const SCANNED_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions'
]

const walk = (entries, section, path, offenders) => {
  for (const [name, value] of entries) {
    const qualifiedName = path ? `${path} > ${name}` : name
    if (typeof value === 'string') {
      if (/^[\^~]/.test(value)) {
        offenders.push({ section, name: qualifiedName, range: value })
      }
    } else if (value && typeof value === 'object') {
      walk(Object.entries(value), section, qualifiedName, offenders)
    }
  }
}

export const findUnpinned = (pkg) => {
  const offenders = []
  for (const section of SCANNED_SECTIONS) {
    walk(Object.entries(pkg[section] ?? {}), section, '', offenders)
  }
  return offenders
}

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
