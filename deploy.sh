#!/bin/bash
echo "🚀 Deploying..."
git add .
if git diff --staged --quiet; then
  echo "✅ Nothing to commit"
else
  MSG=${1:-"update: $(date '+%Y-%m-%d %H:%M')"}
  git commit -m "$MSG"
  git push origin main
  echo "✅ Done: $MSG"
fi
