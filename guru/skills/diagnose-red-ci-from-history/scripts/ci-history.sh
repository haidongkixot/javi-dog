#!/usr/bin/env bash
# Prints the CI history of a branch, one line per run, newest first, with a hint per red run:
#   FLAKE?  the commit changed only docs/config paths, so the failure cannot come from its diff
#   CODE    the commit changed code
# and the failing step names. Read-only: uses the GitHub CLI (`gh`) and local git objects.
#
# Usage: ci-history.sh <branch> [limit] [docs-regex]
#   docs-regex defaults to '^(docs/|guru/|.*\.md$)'
# Requires: gh (authenticated, read access to Actions), git with the commits fetched.
set -euo pipefail

branch=${1:?usage: ci-history.sh <branch> [limit] [docs-regex]}
limit=${2:-30}
docs_re=${3:-'^(docs/|guru/|.*\.md$)'}

gh run list --branch "$branch" --limit "$limit" \
  --json databaseId,headSha,conclusion,status,createdAt,displayTitle \
  --jq '.[] | [.databaseId, .headSha, ((.conclusion // "") | if . == "" then "-" else . end), .status, .createdAt, .displayTitle] | @tsv' |
while IFS=$'\t' read -r id sha conclusion status created title; do
  # Tabs are IFS whitespace, so empty fields would collapse; "-" stands for "no conclusion yet".
  [ "$conclusion" = "-" ] && conclusion=""
  short=${sha:0:7}
  result=${conclusion:-$status}
  hint=""
  if [ "$conclusion" = "failure" ]; then
    if files=$(git show --name-only --format= "$sha" 2>/dev/null); then
      if [ -n "$files" ] && ! grep -v -E "$docs_re" <<<"$files" >/dev/null; then
        hint="FLAKE? (docs-only diff)"
      else
        hint="CODE"
      fi
    else
      hint="(commit not fetched)"
    fi
    steps=$(gh run view "$id" --json jobs \
      --jq '[.jobs[].steps[] | select(.conclusion=="failure") | .name] | join(", ")' 2>/dev/null || true)
    [ -n "$steps" ] && hint="$hint failed: $steps"
  elif [ "$conclusion" = "cancelled" ]; then
    hint="NOT EVALUATED (superseded run cancelled)"
  fi
  printf '%s  %-8s %-10s run=%s  %s  %s\n' "$created" "$short" "$result" "$id" "$title" "$hint"
done
