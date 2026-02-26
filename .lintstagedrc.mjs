export default {
  '*.{js,json,md}': 'prettier --write',
  'docs/architecture/decisions/*.md': 'npm run adr:generate:toc',
  '*': () => 'gitleaks protect --staged --no-banner --verbose',
}
