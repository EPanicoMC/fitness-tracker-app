#!/bin/bash
MSG=${1:-"update: $(date '+%Y-%m-%d %H:%M')"}
git add .
git diff --staged --quiet && echo "✅ Nothing" && exit 0
git commit -m "$MSG"
git push origin main
echo "✅ Deployed: $MSG"
