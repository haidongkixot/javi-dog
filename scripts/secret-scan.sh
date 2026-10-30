#!/usr/bin/env bash
# secret-scan.sh — fail-closed secret scan of a git diff (from guru/skills/fail-closed-checks).
# Javi's Dog: the push gate in docs/agent-ops/TEAM.md (merge checklist item 4); run with
# `pnpm secrets:scan origin/<branch>..HEAD`.
#
# Usage:  secret-scan.sh <revision-range>     e.g. origin/main..HEAD, HEAD~1..HEAD, --cached
#         secret-scan.sh --self-test
# Exit:   0 clean · 1 match (file names printed, never the matched text) · 2 could not scan
# Config: SECRET_SCAN_PATTERNS — one extended regex (alternatives joined with |) for your own
#         token formats; defaults to a few common shapes. Add your product's token prefixes.
#
# Why three exit codes: grep answers 0 (match), 1 (no match) or 2 (error). `if grep …` and
# `! grep …` read an error as "no match", so a broken pattern or a failed diff looks clean.
# This script maps every outcome explicitly and treats "could not scan" as a failure.
set -u

DEFAULT_PATTERNS='jd_it_[A-Za-z0-9_-]{43}|npg_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|(postgres(ql)?|mysql|mongodb(\+srv)?)://[^/[:space:]:@]+:[^@[:space:]]+@'

die() {
  echo "secret-scan: cannot scan: $*" >&2
  exit 2
}

scan() {
  { [ $# -eq 1 ] && [ -n "$1" ]; } || die "expected exactly one non-empty revision range"
  local range=$1
  local pat=${SECRET_SCAN_PATTERNS:-$DEFAULT_PATTERNS}
  local diff rc lines files

  # 1. The pattern must compile. On an empty input a valid pattern gives 1; a broken one gives 2.
  grep -qE -e "$pat" </dev/null
  rc=$?
  [ "$rc" -eq 1 ] || die "pattern is invalid (grep exit $rc)"

  # 2. The diff must be produced. A wrong range, a missing repository or a missing git is exit 2.
  diff=$(git diff --no-ext-diff --no-color "$range" -- 2>/dev/null) || die "git diff '$range' failed"
  lines=$(grep -c -e '^[+-]' <<<"$diff")

  # 3. Map every grep outcome. A here-string, not a pipe: no SIGPIPE status on an early match.
  grep -qE -e "$pat" <<<"$diff"
  rc=$?
  case $rc in
    1)
      echo "secret-scan: clean ($range, $lines changed lines scanned)"
      return 0
      ;;
    0)
      echo "secret-scan: MATCH in $range. Files (matched text not shown):" >&2
      files=$(git diff --no-ext-diff --name-only -G"$pat" "$range" -- 2>/dev/null) \
        || files="(file list unavailable)"
      printf '  %s\n' $files >&2
      return 1
      ;;
    *)
      die "grep exit $rc while scanning"
      ;;
  esac
}

self_test() {
  local self dir rc
  self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  dir=$(mktemp -d) || { echo "self-test: mktemp failed" >&2; return 2; }
  (
    cd "$dir" || exit 2
    git init -q . >/dev/null 2>&1 || exit 2
    git config user.name self-test && git config user.email self-test@example.invalid \
      && git config commit.gpgsign false || exit 2
    echo "hello" >a.txt && git add a.txt && git commit -qm one || exit 2
    echo "world" >>a.txt && git commit -qam two || exit 2
    # Build the fake key at run time, so this file itself never contains a matching string.
    fake="AKIA$(printf 'Q%.0s' $(seq 1 16))"
    printf 'key = %s\n' "$fake" >b.txt && git add b.txt && git commit -qm three || exit 2

    fails=0
    check() { # <name> <expected exit> <expected text or -> <command…>
      local name=$1 want=$2 text=$3 out got
      shift 3
      out=$("$@" 2>&1)
      got=$?
      if [ "$got" -ne "$want" ]; then
        echo "FAIL $name: exit $got, expected $want"; fails=$((fails + 1)); return
      fi
      case $out in *"$fake"*) echo "FAIL $name: printed the secret"; fails=$((fails + 1)); return ;; esac
      if [ "$text" != "-" ]; then
        case $out in *"$text"*) ;; *) echo "FAIL $name: output lacks '$text'"; fails=$((fails + 1)); return ;; esac
      fi
      echo "ok   $name (exit $got)"
    }
    check "clean range" 0 "clean" bash "$self" HEAD~2..HEAD~1
    check "match names the file, not the text" 1 "b.txt" bash "$self" HEAD~1..HEAD
    check "unknown revision" 2 "cannot scan" bash "$self" no-such-rev..HEAD
    check "missing argument" 2 "cannot scan" bash "$self"
    check "empty argument" 2 "cannot scan" bash "$self" ""
    check "invalid pattern" 2 "pattern is invalid" env SECRET_SCAN_PATTERNS='(' bash "$self" HEAD~1..HEAD
    check "not a repository" 2 "cannot scan" env GIT_DIR=/nonexistent bash "$self" HEAD~1..HEAD
    check "custom pattern" 1 "a.txt" env SECRET_SCAN_PATTERNS='wor[l]d' bash "$self" HEAD~2..HEAD~1
    exit "$fails"
  )
  rc=$?
  rm -rf "$dir"
  if [ "$rc" -eq 0 ]; then echo "self-test PASS"; else echo "self-test FAIL ($rc)"; fi
  return "$rc"
}

case "${1-}" in
  --self-test) self_test; exit $? ;;
  -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
esac
scan "$@"
