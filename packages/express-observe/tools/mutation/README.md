# Mutation checks

Hand-picked breakages that the tests must catch: each removes or weakens one safeguard (a safety limit, a termination rule, a privacy rule) and the relevant tests are run against the broken code.

```bash
node tools/mutation/run.js
```

```bash
node tools/mutation/run.js doctor
```

- The target text of each mutation must appear exactly once in its file; otherwise the mutation is reported as **NOT APPLIED** and the spec needs updating.
- **caught**: the tests failed or timed out. **SURVIVED**: the tests passed, so that safeguard is not protected by a test.
- Mutations marked `equivalent` do not change observable behaviour and are expected to survive; each states why.
- Files are restored after every run, including when the runner is interrupted with Ctrl+C. Do not edit source files while it runs.

This is not a general mutation-testing tool such as Stryker. It re-checks, reproducibly, the specific breakages that were tried by hand during development. Earlier counts in TODO.md came from one-off scripts that were not kept; the specs here re-create the most important of them. Results of the latest run are kept in [RESULTS.md](RESULTS.md).
