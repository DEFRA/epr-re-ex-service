# 61. Structure of epr-backend modules

Date: 2026-11-27

## Status

Proposed

Supersedes [ADR 0027](0027-modular-monolith-structure.md)

## Context

[ADR 0027](0027-modular-monolith-structure.md) proposed splitting epr-backend into modules within one deployable service, so that two teams could work in it without treading on each other. The team took that approach, and the code has moved past what 0027 describes:

- **Modules sit directly under `src/`,** such as `src/organisation-read-model/`, not under `src/modules/`.
- **The public interface is in use now,** not a future step. Lint already fences the first modules, refusing any import into one except through its entry points.
- **The reason for a boundary has changed.** Modules were drawn by team. What matters now is a clear boundary between responsibilities, and which service owns each kind of data, because some of that data is leaving re-ex, the reprocessor and exporter service that epr-backend belongs to.

Much of epr-backend is still in the older layout, with domain types under `src/domain/`, repositories under `src/repositories/` and routes under `src/routes/`. The team has asked whether, for example, the organisations repository and domain types move into the organisations module. They do. This ADR states the shape every module ends up in, so that anyone can compare a module with it and close the difference.

## Decision

### A module owns one responsibility, and everything that serves it

A module is a directory directly under `src/`. It owns:

- **its domain types** and the pure rules over them,
- **the port for its data** and every adapter of that port, such as MongoDB and in-memory,
- **its routes,**
- **any application service and queue command handler** that acts on its data.

Domain vocabulary, such as a model's types or the format of a registration number, goes out through the owning module's public interface. Technical code with no domain owner, such as authentication, logging and the server setup, stays outside the modules. So a directory such as `src/common/`, `src/plugins/` or `src/server/`, which holds no domain data or routes of its own, is not a module.

### Module boundaries follow who owns the data

Re-ex is handing some of its data to other services over time, among them Reg Accred, the registration and accreditation service. Will Crossland set out the plan in November 2026:

| Data                 | Now   | Near term  | Long term                                        |
| -------------------- | ----- | ---------- | ------------------------------------------------ |
| Organisations        | re-ex | re-ex      | Manage Account, or another service outside re-ex |
| Registrations        | re-ex | re-ex      | Reg Accred                                       |
| 2026 accreditations  | re-ex | re-ex      | Reg Accred                                       |
| 2027+ accreditations | re-ex | Reg Accred | Reg Accred                                       |

A module's boundary is drawn so that code leaves with the data it serves. That gives three rules:

- **Code that serves or changes only registrations and accreditations sits in a module of its own,** so it can leave for Reg Accred by deleting that module.
- **Code that edits an organisation as a whole,** such as a trading name change, sits with organisations, which stay in re-ex the longest.
- **Once Reg Accred holds 2027+ accreditations, re-ex reads them from it** behind the [organisation read model](0052-organisation-read-model.md)'s port.

The `PUT` of `/v1/organisations/{id}` is an exception. It writes the whole organisation document, nested registrations and accreditations included, so it sidesteps every module's rules. It predates the admin frontend and should hardly be used now, and it sits with organisations.

When the ownership plan changes, the module boundaries follow it.

### Other code reaches a module only through its entry points

A module has up to three entry points, and each lists its exports by name:

- **`index.js`** is the public interface. It holds the module's types, including the type of each port it provides, and its pure rules. It loads no route, adapter or Hapi code.
- **`plugin.js`** holds the module's Hapi plugins. Only code in `src/server/`, `src/plugins/` and `src/test/` imports it.
- **`test-support.js`** holds the module's in-memory adapters, their plugins and its test builders. Only tests import it.

Lint fences every module, so an import that reaches past a module's entry points fails. Lint cannot see a JSDoc type import or a test mock, so CI also refuses either one when it is aimed at a module's internals.

### What a module offers other code is a port

A port is a capability other code uses, such as a repository or an application service. A module's index and its port are one interface, split by role:

- **The port is how a caller asks the module to do something,** whether that is fetching, saving, sending or any other application service. Callers reach it from the request or from `server.app`.
- **`index.js` describes what those requests take and return.** It holds the module's types, its constants, and the rules that answer questions about a value of those types. Callers import it.

A repository that several modules reach into is a sign that a capability is missing. Its owning module presents it as a port, with an application service in front where callers need more than storage. An adapter may depend on other modules' ports, as the organisation read model's adapter depends on overseas sites. A service that only combines several modules' ports for one caller is built where it is used, and is not a port of its own.

### Modules wire together through Hapi plugins that declare what they need

- **A module's routes are a route plugin.**
- **Each adapter of a port is a plugin of its own, named after the port.** It provides that port and nothing else, so Hapi refuses a server that registers two adapters of one port.
- **Each plugin declares the ports it needs.** Hapi checks them when the server initialises, so a server with a missing provider refuses to start rather than failing on a request.
- **The server setup makes the decisions.** It picks each adapter, reads config and feature flags, and passes each plugin plain values. A plugin never reads config or a feature flag.
- **The test server registers a port's in-memory adapter** where production registers the MongoDB one. Tests replace a port, never anything built from it.

The how-to for all of this, with the helpers that implement it, is [`src/modules.md`](https://github.com/DEFRA/epr-backend/blob/main/src/modules.md) in epr-backend. Each module's README says what the module serves and how it is laid out inside.

### Modules move to this shape one at a time

Each module moves in its own pull request, or in a few small ones where it is large. A move changes structure only. It changes no behaviour, removes no test and keeps coverage at 100%. Until every module has moved, the older layout and the module layout sit side by side.

### Open question: one plugin per module

Today a module that offers routes and a port has a route plugin and one plugin for each adapter. The server setup registers the adapter, so the test server can register the in-memory one, and the route plugin does not care which.

A module could instead expose a single plugin that takes the adapter as an option, which would make the server setup one line per module. That plugin would then carry the adapter choice as well as the routes. It would also have to serve a module that offers only a port, and a server that wants a port without its routes.

This ADR leaves the question open. One module trials a single plugin, and a later ADR records what the trial shows. Until then, every other module keeps a route plugin and a plugin for each adapter.

## Consequences

### Advantages

- **Anyone can compare a module with the target** and see what is left to move.
- **Code leaves with its data.** When registrations and accreditations go to Reg Accred, the code that serves only them goes by deleting a module.
- **A badly wired server fails when it starts,** because Hapi checks every declared dependency at initialisation.
- **Tests swap a port, not its internals,** so a test exercises the same wiring as production apart from the adapter.

### Disadvantages

- **Each module has more files,** with a plugin for each adapter and up to three entry points.
- **The boundary is enforced by lint, not at runtime.** Hapi gives no plugin privacy, so any plugin can depend on any port by name.

### Risks and mitigations

| Risk                                                     | Mitigation                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A move to the module shape changes behaviour by accident | Each move changes structure only, keeps every test and holds coverage at 100%                           |
| Modules drift from the shape as new code lands           | Lint fences every module, and every module README points at `src/modules.md` for how to build the shape |
| The single-plugin trial pulls modules in two directions  | Only the trial module changes until a later ADR records the result                                      |
