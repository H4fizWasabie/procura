#!/bin/bash
# Pre-commit hook: enforce CHANGELOG.md update on every change.
# Checks if CHANGELOG.md has been modified in the staged changes.
# If not, rejects the commit with instructions.

CHANGELOG="CHANGELOG.md"

# Not a git repo? skip
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Check if CHANGELOG.md is staged
if git diff --cached --name-only | grep -q "^${CHANGELOG}$"; then
    # CHANGELOG is staged — check it's not empty (just the header)
    if git diff --cached -- "${CHANGELOG}" | grep -q '^+'; then
        exit 0
    fi
fi

# CHANGELOG.md not staged or has no additions
cat >&2 <<EOF
============================================================
COMMIT REJECTED: CHANGELOG.md not updated.

Every code change must be recorded in CHANGELOG.md.
Format:
  ## YYYY-MM-DD
  - [module] what changed — why

Stage your CHANGELOG.md update, then retry the commit.
============================================================
EOF
exit 1
