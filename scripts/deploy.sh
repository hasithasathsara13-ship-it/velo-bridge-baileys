#!/bin/bash
# Zero-downtime deployment script for Zeabur
# Preserves sessions across deployments
# Run this manually OR let Zeabur trigger it

set -e

echo "🚀 Starting zero-downtime deployment..."

# 1. Check if sessions exist
if [ ! -d "sessions" ] || [ -z "$(ls -A sessions 2>/dev/null)" ]; then
  echo "⚠️  No existing sessions found (fresh deployment or first run)"
  HAS_SESSIONS=false
else
  echo "✅ Found existing sessions"
  HAS_SESSIONS=true
fi

# 2. Pull latest code
echo "📥 Pulling latest code from Git..."
git fetch origin
git reset --hard origin/main
echo "✅ Code updated"

# 3. Install dependencies (if package.json changed)
if git diff HEAD@{1} --name-only | grep -q "package.json"; then
  echo "📦 Installing dependencies..."
  npm install --production
else
  echo "⏭️  Skipping npm install (package.json unchanged)"
fi

# 4. Build TypeScript
echo "🔨 Building TypeScript..."
npm run build
echo "✅ Build complete"

# 5. Restart with zero downtime
if [ "$HAS_SESSIONS" = true ]; then
  echo "🔄 Graceful restart (preserving sessions)..."
  
  # Check if PM2 is available
  if command -v pm2 &> /dev/null; then
    # PM2 reload = zero downtime
    pm2 reload velo-bridge-baileys --update-env || pm2 restart velo-bridge-baileys
  else
    # Fallback: just restart the process (Zeabur handles this automatically)
    echo "⚠️  PM2 not found, relying on Zeabur auto-restart"
  fi
  
  echo "✅ Deployment complete - sessions preserved!"
else
  echo "✅ Deployment complete - fresh start (no sessions to preserve)"
fi

echo ""
echo "📊 Current session status:"
ls -lh sessions/ 2>/dev/null | grep -v "^total" | wc -l | xargs echo "   Connected businesses:"

echo ""
echo "✨ Done! All businesses should remain connected."
