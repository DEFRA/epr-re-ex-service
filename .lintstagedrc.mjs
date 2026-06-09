export default {
  '*.{js,json,md}': 'prettier --write',
  '{renovate.json,renovate-presets/*.json}': () => 'npm run validate:renovate',
  'docs/architecture/decisions/*.md': 'npm run adr:generate:toc',
  '*': () => 'gitleaks protect --staged --no-banner --verbose'
}
