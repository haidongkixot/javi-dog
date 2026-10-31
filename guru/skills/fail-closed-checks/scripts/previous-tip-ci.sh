#!/usr/bin/env bash
# previous-tip-ci.sh — fail-closed "is CI green on the last pushed tip?" check
# (from the fail-closed-checks skill). Run it as the first step of every push.
#
# Usage:  previous-tip-ci.sh <branch> [sha]     sha defaults to origin/<branch> (fetch first)
#         previous-tip-ci.sh --self-test
# Exit:   0 every run for that commit completed with success (or skipped/neutral)
#         1 a run completed red (failure, timed_out, startup_failure, action_required)
#         2 could not tell: gh missing or failing, no run for the commit, a run still queued
#           or in progress, a cancelled run (never evaluated), an unknown conclusion
# Prints: "CI green on <sha7> (run <id>[, <id>…])" on 0; the reason on 1 and 2.
#
# Why: a team rule "read CI on the previous tip before pushing" slipped repeatedly when it
# lived in memory only. As a check it has three answers, and "could not tell" refuses.
# Read-only: uses `gh run list` (GitHub CLI) and `git rev-parse`. GH_CMD overrides `gh`.
set -u

GH=${GH_CMD:-gh}

say() { printf '%s\n' "previous-tip-ci: $*"; }
unknown() { say "cannot tell: $*" >&2; exit 2; }

check() {
  { [ $# -ge 1 ] && [ -n "$1" ]; } || unknown "expected a branch name"
  local branch=$1 sha=${2:-}
  if [ -z "$sha" ]; then
    sha=$(git rev-parse --verify --quiet "origin/$branch^{commit}") ||
      unknown "origin/$branch not found (run git fetch first)"
  elif ! [[ $sha =~ ^[0-9a-f]{40}$ ]]; then
    # gh filters by the full SHA only; an abbreviation would read as "no run".
    sha=$(git rev-parse --verify --quiet "$sha^{commit}") || unknown "'$2' is not a known commit"
  fi
  command -v "$GH" >/dev/null 2>&1 || unknown "'$GH' not found"

  local rows
  rows=$("$GH" run list --branch "$branch" --commit "$sha" --limit 50 \
    --json databaseId,status,conclusion \
    --jq '.[] | "\(.databaseId) \(.status) \(.conclusion // "")"' 2>/dev/null) ||
    unknown "gh run list failed (auth, network or permissions)"
  [ -n "$rows" ] || unknown "no CI run for ${sha:0:7} on $branch (not pushed, not triggered, or not registered yet)"

  local id status conclusion green_ids="" red="" pending="" odd=""
  while read -r id status conclusion; do
    [ -n "$id" ] || continue
    if [ "$status" != "completed" ]; then pending="$pending $id($status)"; continue; fi
    case $conclusion in
      success | skipped | neutral) green_ids="$green_ids${green_ids:+, }$id" ;;
      failure | timed_out | startup_failure | action_required) red="$red $id($conclusion)" ;;
      *) odd="$odd $id(${conclusion:-none})" ;; # cancelled, stale, empty: never evaluated
    esac
  done <<<"$rows"

  if [ -n "$red" ]; then say "RED on ${sha:0:7}:$red — diagnose and record before pushing"; exit 1; fi
  [ -z "$pending" ] || unknown "run(s) not finished on ${sha:0:7}:$pending"
  [ -z "$odd" ] || unknown "run(s) not evaluated on ${sha:0:7}:$odd"
  say "CI green on ${sha:0:7} (run $green_ids)"
  exit 0
}

self_test() {
  local dir fails=0
  dir=$(mktemp -d) || { echo "self-test: mktemp failed" >&2; exit 2; }
  trap 'rm -rf "$dir"' EXIT
  # Fake gh: prints the already-filtered rows in $FAKE_ROWS, or fails when $FAKE_FAIL is set.
  cat >"$dir/gh" <<'EOF'
#!/usr/bin/env bash
[ -n "${FAKE_FAIL:-}" ] && exit 1
printf '%b' "${FAKE_ROWS:-}"
EOF
  chmod +x "$dir/gh"
  expect() { # <want-exit> <label> [env assignments…]
    local want=$1 label=$2 got
    shift 2
    env GH_CMD="$dir/gh" "$@" bash "$0" main 0123456789abcdef0123456789abcdef01234567 >/dev/null 2>&1
    got=$?
    if [ "$got" -eq "$want" ]; then echo "ok   $label (exit $got)"; else
      echo "FAIL $label (want $want, got $got)"; fails=$((fails + 1)); fi
  }
  expect 0 "one green run" FAKE_ROWS='101 completed success\n'
  expect 0 "green + skipped workflow" FAKE_ROWS='101 completed success\n102 completed skipped\n'
  expect 1 "one red run" FAKE_ROWS='101 completed failure\n'
  expect 1 "red beside green" FAKE_ROWS='101 completed success\n102 completed timed_out\n'
  expect 2 "no run for the commit" FAKE_ROWS=''
  expect 2 "run in progress" FAKE_ROWS='101 in_progress \n'
  expect 2 "cancelled run" FAKE_ROWS='101 completed cancelled\n'
  expect 2 "gh fails" FAKE_FAIL=1
  expect 2 "gh missing" GH_CMD="$dir/does-not-exist"
  env GH_CMD="$dir/gh" bash "$0" >/dev/null 2>&1
  if [ $? -eq 2 ]; then echo "ok   missing branch argument (exit 2)"; else
    echo "FAIL missing branch argument"; fails=$((fails + 1)); fi
  if [ "$fails" -eq 0 ]; then echo "self-test PASS"; exit 0; fi
  echo "self-test FAIL ($fails)"; exit 1
}

if [ "${1:-}" = "--self-test" ]; then self_test; else check "$@"; fi
