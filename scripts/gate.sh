#!/usr/bin/env bash
# gate.sh — the full pre-push gate (docs/agent-ops/TEAM.md, merge checklist item 3), fail-closed.
#
# Usage:  pnpm gate            format, lint, typecheck, tests, build, migration drift, docs
#         pnpm gate --csp      the same, then the bounded browser CSP check (needs Chromium)
# Exit:   0 every step passed · 1 a step failed (named on stderr)
#
# Every step must pass; there is no `;` between steps. The test step clears the shared Vitest
# cache first (parallel lanes collided on it in S5f) and fails on any "Unhandled" error even
# when Vitest exits 0. The test log goes to a temporary file and is kept only on failure. A
# failure also prints the load average.
set -uo pipefail

csp=0
for arg in "$@"; do
  case "$arg" in
    --csp) csp=1 ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "gate: unknown argument: $arg" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.." || exit 1

# Load average at the moment of a failure: parallel lanes running test suites pushed it to ~20
# in S5g and made a 5 s test time out (Guru GB-F5). Read it before deciding a failure is real.
load_note() {
  local load=unknown
  if [ -r /proc/loadavg ]; then
    load=$(cut -d' ' -f1-3 /proc/loadavg)
  elif command -v sysctl >/dev/null 2>&1; then
    load=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs) || load=unknown
  fi
  echo "gate: load average (1/5/15 min): ${load:-unknown}" >&2
}
fail() {
  echo "gate: FAIL — $1" >&2
  load_note
  exit 1
}
step() {
  local name=$1
  shift
  "$@" >/dev/null 2>&1 || fail "$name"
  echo "gate: ok   $name"
}

step 'format:check' pnpm -s format:check
step 'lint' pnpm -s lint
step 'typecheck' pnpm -s typecheck
step 'test:scripts' pnpm -s test:scripts

rm -rf node_modules/.vitest-cache
log=$(mktemp) || fail 'cannot create a temporary log'
if ! pnpm -s test --force >"$log" 2>&1; then
  echo "gate: test log kept at $log" >&2
  fail 'test'
fi
if grep -q 'Unhandled' "$log"; then
  echo "gate: test log kept at $log" >&2
  fail 'test (an Unhandled error was reported)'
fi
counts=$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E ':test: +Tests +[0-9]+ passed' |
  sed -E 's/.*Tests +([0-9]+) passed.*/\1/' | awk '{p += $1; n++} END {print n " packages, " p " tests passed"}')
rm -f "$log"
echo "gate: ok   test ($counts)"

step 'build' pnpm -s build
(cd packages/event-store && pnpm -s db:generate | grep -q 'No schema changes') ||
  fail 'migration drift (schema differs from the committed SQL)'
echo 'gate: ok   migration drift'
step 'docs:check' pnpm -s docs:check

if [ "$csp" -eq 1 ]; then
  step 'csp:check' pnpm --filter @javis-dog/web csp:check
fi
echo 'gate: PASS'
