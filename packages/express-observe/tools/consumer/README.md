# Consumer check

Uses the package the way someone who installs it would, instead of through relative imports inside the repository.

```bash
npm run consumer:check
```

```bash
node tools/consumer/run.js express5
```

The runner packs the package with `npm pack` and installs the tarball into one clean project per profile:

| Profile | Express | @types/express | TypeScript |
|---|---|---|---|
| express4-typescript5 | 4.22.3 | 4.17.25 | 5.9.3 |
| express5-typescript7 | 5.3.0 | 5.0.6 | 7.0.2 |

In each project it checks four things, in order, and stops at the first failure:

1. **install**: the tarball and its dependencies install.
2. **runtime (CommonJS)**: `fixtures/runtime.cjs` serves a request and checks the headers and the record.
3. **types**: `tsc` in strict mode compiles `fixtures/usage.ts` (correct usage) and `fixtures/misuse.ts`. Each line marked `@ts-expect-error` in the misuse file must be a type error, so types that become too loose fail the check as well as types that become too strict.
4. **cli**: `npx express-observe --version` runs from `node_modules`.

This catches problems the Jest suite cannot see: a file missing from `files` in package.json, a wrong `types` path, a broken `bin`, or type definitions that drift from the runtime.

- It needs network access, because each run installs Express, TypeScript and the type packages from the registry.
- Work happens in `.consumer-test/` next to package.json, which is git-ignored and recreated on every run.
- CI runs it on Ubuntu and Windows after the tests.
