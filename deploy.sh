#!/bin/bash
set -e
MSG=${1:-"update: $(date '+%Y-%m-%d %H:%M')"}
git add .
if ! git diff --staged --quiet; then
  git commit -m "$MSG"
fi

AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "1")
if [ "$AHEAD" -eq 0 ]; then
  echo "✅ Nothing to commit or push (origin/main is up to date)"
  exit 0
fi

echo "🚀 Pushing $AHEAD commit(s) to origin/main..."
git push origin main
echo "✅ Deployed: $MSG"


