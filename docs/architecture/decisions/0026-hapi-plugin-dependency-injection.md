# 26. Hapi Plugin Dependency Injection via Adapter Plugins

Date: 2025-01-27

## Status

Proposed

## Context

The epr-backend uses the ports and adapters (hexagonal) architecture pattern for repositories and other infrastructure components. This enables swapping implementations for testing (e.g. in-memory repositories) versus production (e.g. MongoDB-backed repositories).

The current implementation embeds conditional logic inside plugins to switch between implementations:

```javascript
// Current pattern in repositories.js (simplified)
register: (server, options) => {
  if (options.testOverride) {
    // Use test implementation
  } else if (skipMongoDb) {
    // Skip or use fallback
  } else {
    server.dependency('mongodb', async () => {
      // Create production implementation
    })
  }
}
```

### Problems with the Current Approach

1. **Conditional logic duplication**: The same 3-branch pattern (test override → skip MongoDB → production) is repeated 8+ times in `repositories.js` alone (216 lines of mostly repetitive wiring code).

2. **Test mode detection is implicit**: The `skipMongoDb` flag is threaded through multiple plugins, creating hidden coupling between components.

3. **Production code contains test paths**: Code that only executes in tests lives alongside production code, making it harder to reason about what runs in production.

4. **Complex option passing**: Tests must construct elaborate options objects to override individual repositories, workers, and feature flags.

5. **Per-request lazy initialisation overhead**: The current implementation uses `Object.defineProperty` getters on the request object for lazy initialisation, adding complexity when stateless repositories could simply live on `server.app`.

### Requirements

- Repositories depend on MongoDB (in production) or nothing (in tests)
- Workers depend on repositories
- Routes depend on repositories and workers
- Tests must be able to use in-memory adapters without any persistence infrastructure
- The dependency chain must be explicit and easy to understand

## Decision

Use **separate adapter plugins with the same plugin name** to switch implementations at the composition level rather than inside plugins.

### The Pattern

Each infrastructure concern has multiple adapter plugins that share the same `name`. Only one is registered depending on the deployment context (production vs test).

```javascript
// mongo-repositories-plugin.js (production)
export const mongoRepositoriesPlugin = {
  name: 'repositories',
  dependencies: ['mongodb'],
  register: async (server) => {
    const db = server.app.db
    server.app.repositories = {
      summaryLogs: await createSummaryLogsRepository(db),
      organisations: await createOrganisationsRepository(db),
      uploads: createUploadsRepository(createS3Client()),
      // ... other repositories
    }
  }
}

// inmemory-repositories-plugin.js (test)
export const inMemoryRepositoriesPlugin = {
  name: 'repositories',
  register: (server) => {
    server.app.repositories = {
      summaryLogs: createInMemorySummaryLogsRepository(),
      organisations: createInMemoryOrganisationsRepository(),
      uploads: createInMemoryUploadsRepository(),
      // ... other repositories
    }
  }
}
```

### Server Composition

The server setup becomes explicit plugin composition:

```javascript
// Production server
export const createProductionServer = async () => {
  const server = Hapi.server({ /* config */ })
  await server.register([
    mongoPlugin,
    mongoRepositoriesPlugin,
    productionWorkersPlugin,
    configFeatureFlagsPlugin,
    router
  ])
  return server
}

// Test server
export const createTestServer = async () => {
  const server = Hapi.server({ /* config */ })
  await server.register([
    inMemoryRepositoriesPlugin,
    testWorkersPlugin,
    testFeatureFlagsPlugin,
    router
  ])
  return server
}
```

### Accessing Dependencies

Plugins and route handlers access dependencies via `server.app`:

```javascript
// In a route handler
export const organisationsGetAll = {
  method: 'GET',
  path: '/v1/organisations',
  handler: async (request, h) => {
    const { organisations } = request.server.app.repositories
    const results = await organisations.findAll()
    return h.response(results).code(200)
  }
}

// In a plugin that depends on repositories
export const qConsumerPlugin = {
  name: 'qConsumer',
  dependencies: ['repositories'],
  register: async (server, options) => {
    const consumer = new SqsConsumer({
      queueUrl: options.queueUrl,
      handleMessage: async (message) => {
        await processMessage(message, server.app.repositories)
      }
    })
    consumer.start()
    server.events.on('stop', () => consumer.stop())
  }
}
```

### Dependency Declaration

Use the `dependencies` array when:
- A plugin always requires another plugin to be registered
- You want Hapi to throw a helpful error if the dependency is missing

Omit dependencies when:
- You control the registration order (most internal applications)
- The dependency is implicit from the composition

### Alternatives Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Options-based switching** (current) | Single plugin file; all logic in one place | Conditional logic duplication; test paths in production code; complex options threading | ❌ Rejected |
| **Separate adapter plugins** (proposed) | Simple plugins; explicit composition; no test paths in production | More files; must ensure consistent interfaces | ✅ Selected |
| **Dependency injection container** | Automatic wiring; familiar to developers from other frameworks | Adds complexity; not idiomatic Hapi; magic reduces explicitness | ❌ Rejected |

## Consequences

### Benefits

- **Simple plugins**: Each plugin does one thing, typically under 30 lines
- **Explicit composition**: Server setup clearly shows what adapters are used
- **No production test paths**: Production code contains only production logic
- **Easy testing**: Tests register the in-memory adapter plugin, no options threading required
- **Declarative dependencies**: `dependencies: ['mongodb']` makes requirements obvious
- **Contract testing**: Both adapters must implement the same interface, encouraging contract tests

### Trade-offs

- **More files**: Separate adapter plugins means more files to maintain (though each is simpler)
- **Interface discipline**: Both adapters must expose identical interfaces; contract tests become essential
- **Migration effort**: Refactoring existing plugins requires careful incremental work

### Risks

- **Low Risk**: Interface drift between adapters (mitigated by contract tests)
- **Low Risk**: Forgetting to register a required plugin (Hapi's `dependencies` array catches this)

### Migration Path

1. Create new adapter plugins alongside existing code
2. Add contract tests ensuring both adapters implement the same interface
3. Update server composition to use new plugins
4. Remove conditional logic from existing plugins
5. Delete unused code paths

## References

- [Hapi.js Plugin Tutorial](https://hapi.dev/tutorials/plugins/)
- [Ports and Adapters Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
- ADR 0010: Worker Threads (related infrastructure decision)
