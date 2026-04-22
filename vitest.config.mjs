import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['.github/**/*.test.mjs', 'scripts/**/*.test.mjs'],
    exclude: ['lib/**', 'node_modules/**']
  }
})
