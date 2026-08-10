const BRANCH_KINDS = { PAE: 'jira', ADR: 'adr' }
const BRANCH_PATTERN = /^((PAE|ADR)-\d+)[-_].+$/i
const AUTOMATED_BRANCH_PREFIXES = [
  'dependabot/',
  'renovate/',
  'revert-',
  'snyk-'
]

export const parseBranch = (branchName) => {
  const [, key, prefix] = branchName?.match(BRANCH_PATTERN) ?? []
  if (!key) {
    return null
  }

  return { key: key.toUpperCase(), kind: BRANCH_KINDS[prefix.toUpperCase()] }
}

export const isAutomatedBranch = ({ branchName, actor }) =>
  actor?.endsWith('[bot]') ||
  AUTOMATED_BRANCH_PREFIXES.some((prefix) => branchName?.startsWith(prefix))

const isRunAsScript = () => import.meta.url === `file://${process.argv[1]}`

if (isRunAsScript()) {
  const [branchName, actor] = process.argv.slice(2)
  const { appendFile } = await import('node:fs/promises')
  const outputPath = process.env.GITHUB_OUTPUT

  if (!outputPath) {
    console.error('GITHUB_OUTPUT is not set - this must run in GitHub Actions')
    process.exit(1)
  }

  const setOutput = (line) => appendFile(outputPath, `${line}\n`)

  if (isAutomatedBranch({ branchName, actor })) {
    console.log(`Automated PR from ${actor} on ${branchName} - skipping checks`)
    await setOutput('skip=true')
    process.exit(0)
  }

  const branch = parseBranch(branchName)

  if (!branch) {
    console.error(
      `Branch name "${branchName}" does not match the required format: PAE-<NUMBER>-<desc> or ADR-<NUMBER>-<desc>`
    )
    process.exit(1)
  }

  await setOutput(`key=${branch.key}`)
  await setOutput(`kind=${branch.kind}`)
}
