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
