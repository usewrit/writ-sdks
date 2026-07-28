---
name: Bug report
about: An SDK behaves differently from DESIGN.md or from the daemon
title: ""
labels: bug
---

<!-- Never paste a token. `runtime.json` and `local_token` contain live
     credentials — redact them. Security issues: see SECURITY.md, not here. -->

## Which SDK

<!-- typescript / python / go / rust — and whether the others behave the same.
     A difference BETWEEN SDKs is itself a bug: they implement one contract. -->

- [ ] TypeScript (`@usewrit/agent-sdk`)
- [ ] Python (`writ-agent`)
- [ ] Go (`github.com/usewrit/writ-sdks/go`)
- [ ] Rust (`writ-client`)

## What happened

## What you expected

<!-- If DESIGN.md or openapi/writ-agent.yaml specifies this, quote the section. -->

## Reproduction

```
```

## Environment

- SDK version:
- Language/runtime version:
- `writ-agentd` version (`GET /v1/agent`):
- OS:
- Discovery path used: <!-- env vars / WRIT_HOME / ~/.writ profile / default -->
