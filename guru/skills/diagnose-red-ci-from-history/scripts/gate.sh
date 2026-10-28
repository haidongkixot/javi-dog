#!/usr/bin/env bash
# Fail-fast local gate: runs each step in order, stops at the first failure, and prints
# one evidence line per step (exit code, seconds). Use it before every push.
#
# Usage:
#   gate.sh "pnpm format:check" "pnpm lint" "pnpm typecheck" "pnpm test" "pnpm build" "pnpm docs:check"
#   GATE_STEPS_FILE=gate.steps gate.sh        # one command per line, '#' comments allowed
#   gate.sh --self-test                       # proves the gate stops on a failing step
#
# Why: a gate written as `a; b; c` or a loop that only prints failures lets a later green
# step hide an earlier red one, and the push goes out anyway.
set -uo pipefail

run_gate() {
  local i=0 total=$# start rc
  for step in "$@"; do
    i=$((i + 1))
    start=$(date +%s)
    printf '[gate %d/%d] %s\n' "$i" "$total" "$step"
    bash -c "$step"
    rc=$?
    printf '[gate %d/%d] exit=%d seconds=%d :: %s\n' "$i" "$total" "$rc" "$(( $(date +%s) - start ))" "$step"
    if [ "$rc" -ne 0 ]; then
      printf 'GATE FAIL at step %d/%d (%s); later steps NOT RUN.\n' "$i" "$total" "$step"
      return "$rc"
    fi
  done
  printf 'GATE PASS (%d steps)\n' "$total"
}

if [ "${1:-}" = "--self-test" ]; then
  out=$(run_gate "true" "false" "echo SHOULD_NOT_RUN" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && ! grep -q SHOULD_NOT_RUN <<<"$out" && grep -q 'GATE FAIL at step 2/3' <<<"$out"; then
    out2=$(run_gate "true" "true" 2>&1); rc2=$?
    if [ "$rc2" -eq 0 ] && grep -q 'GATE PASS (2 steps)' <<<"$out2"; then
      echo "self-test PASS"; exit 0
    fi
  fi
  echo "self-test FAIL"; printf '%s\n' "$out"; exit 1
fi

steps=("$@")
if [ ${#steps[@]} -eq 0 ] && [ -n "${GATE_STEPS_FILE:-}" ]; then
  mapfile -t steps < <(grep -v -E '^\s*(#|$)' "$GATE_STEPS_FILE")
fi
if [ ${#steps[@]} -eq 0 ]; then
  echo "usage: gate.sh <step> [<step> ...] | GATE_STEPS_FILE=<file> gate.sh | gate.sh --self-test" >&2
  exit 2
fi
run_gate "${steps[@]}"
