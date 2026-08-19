# npm audit fix notes

Branch `fix/npm-audit-and-deps` updates `package.json`:

- `@modelcontextprotocol/sdk` **1.30.0**
- `@types/node` **^26.2.0**
- `tsx` **^4.23.11**
- `overrides` for `fast-uri`, `ip-address`, `hono`, `@hono/node-server`

## Required lockfile step

```bash
npm install
# verify
node -e "const l=require('./package-lock.json'); console.log(l.packages['node_modules/@modelcontextprotocol/sdk'].version, l.packages['node_modules/fast-uri'].version)"
```

Expected: `1.30.0` and `3.1.5` (or newer override resolutions).

Then open/merge the PR so Dependabot successors stay green.
