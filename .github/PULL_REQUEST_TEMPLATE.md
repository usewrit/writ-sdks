## What this changes

## Why

## Which SDKs

- [ ] TypeScript
- [ ] Python
- [ ] Go
- [ ] Rust

<!-- A BEHAVIOUR change is expected in all four, in this PR — that is why they
     share a repo. Docs, typos and per-language idiom fixes are fine alone. -->

## Checklist

- [ ] Tests pass for every SDK I touched
- [ ] A test covers the change — one that **fails before it**
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`, naming the SDKs
- [ ] `DESIGN.md` updated if the cross-language contract changed
- [ ] No new runtime dependency (or the PR explains why one is needed)
- [ ] TypeScript and Go still have **zero** runtime dependencies

## Verified against

- [ ] The mock servers in each test suite
- [ ] A real `writ-agentd` (`WRIT_SMOKE=1`, throwaway `WRIT_HOME`)

Daemon version tested against:
