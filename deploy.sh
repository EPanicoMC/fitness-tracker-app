#!/bin/bash
echo "🚀 Deploy in corso..."
git add .
if git diff --staged --quiet; then
  echo "✅ Nessuna modifica da committare"
else
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
  git commit -m "update: $TIMESTAMP"
  git push origin main
  echo "✅ Push completato: $TIMESTAMP"
fi
