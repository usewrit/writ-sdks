#!/usr/bin/env bash
# Generate additional-language Writ agent clients from the canonical OpenAPI spec.
#
# The hand-written SDKs (typescript/, python/, go/, rust/) are the flagship packages —
# do NOT regenerate those. This pipeline covers the long tail: java, csharp, ruby, php
# (add more generator names as needed; `openapi-generator-cli list` shows all).
#
# Requires a JVM (openapi-generator is a Java tool). Two ways to run it:
#   npx @openapitools/openapi-generator-cli ...   (auto-downloads the jar; needs Java)
#   docker run --rm -v "$PWD:/local" openapitools/openapi-generator-cli ...
#
# Usage: ./generate.sh [lang ...]        # default: java csharp ruby php

set -euo pipefail
cd "$(dirname "$0")"

SPEC="../openapi/writ-agent.yaml"
OUT_ROOT="./generated"
LANGS=("${@:-java csharp ruby php}")
[[ $# -eq 0 ]] && LANGS=(java csharp ruby php)

run_generator() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker run --rm -v "$(cd .. && pwd):/local" openapitools/openapi-generator-cli:v7.10.0 \
      generate -i "/local/openapi/writ-agent.yaml" "${@:2}" -o "/local/codegen/generated/$1"
  else
    npx --yes @openapitools/openapi-generator-cli generate -i "$SPEC" "${@:2}" -o "$OUT_ROOT/$1"
  fi
}

for lang in ${LANGS[@]}; do
  cfg="./configs/$lang.yaml"
  echo "==> generating $lang"
  if [[ -f "$cfg" ]]; then
    run_generator "$lang" -g "$lang" -c "$cfg"
  else
    run_generator "$lang" -g "$lang"
  fi
done

echo "done. output under $OUT_ROOT/<lang>."
echo "note: generated clients are raw REST bindings — they do not include runtime.json"
echo "discovery, Page normalization, or run_and_wait. See ../DESIGN.md for what the"
echo "hand-written SDKs add on top; port those helpers if you promote a generated client."
