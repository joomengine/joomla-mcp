# Contributing

Contributions are welcome when they preserve the native-first and fail-closed
architecture.

## Before changing an action

1. Locate the Joomla 6.1 and 6.2 core route, command, service, model, form, ACL,
   events, and lifecycle behavior that authorizes the change.
2. Prefer an existing Joomla Web Services route for remote behavior.
3. Use a fixed Joomla-native companion action only when the API is absent or a
   structured local contract is required.
4. Never add generic HTTP, CLI, command, shell, PHP, SQL, filesystem, URL,
   component, model, or method passthrough.
5. Define the action ID, schema, toolset, ACL, risk, limits, postcondition, audit
   behavior, and recovery path before enabling execution.

Joomla performs domain validation and persistence. Adapter code must not clone
Joomla business logic or bypass model events and permission checks.

## Local checks

Requirements are Node.js 22.12 or newer and PHP 8.3 or newer with the `zip`
extension for companion packaging.

```bash
npm ci
npm run validate
npm audit --omit=dev --audit-level=high
php companion/tests/run.php
php companion/build.php
```

Run the live fixture matrix for any route, model, ACL, mutation, state, update,
or maintenance behavior that changes. A fixture test must prove success,
least-privilege denial, bounds, postcondition, cleanup, and recovery. Never use
production sites or credentials.

## Pull requests

Keep each pull request focused and include:

- the Joomla source locations and supported versions used as authority;
- the semantic action and toolset affected;
- the native API or companion execution path;
- tests run and fixture versions/databases used;
- security, compatibility, upgrade, and rollback impact;
- documentation changes for any operator-visible behavior.

Do not commit generated `dist/`, `companion/dist/`, local site configuration,
tokens, secrets, fixture databases, or logs containing Joomla data. Generated
release artifacts belong in the release workflow.

## Documentation status language

Use the definitions in [docs/COVERAGE.md](docs/COVERAGE.md): source-backed,
implemented, live-verified, and gated are different states. Offline tests do
not justify claiming production verification.

## License

By contributing, you agree that your contribution is licensed under the GNU
General Public License, version 2 or, at your option, any later version, as
described in [LICENSE](LICENSE).
