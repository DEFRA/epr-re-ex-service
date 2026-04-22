const SCANNED_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]

export const findUnpinned = (pkg) => {
  const offenders = []
  for (const section of SCANNED_SECTIONS) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (/^[\^~]/.test(range)) {
        offenders.push({ section, name, range })
      }
    }
  }
  return offenders
}
