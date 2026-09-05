#!/bin/bash
# Restore sessions from backup (emergency use only)
# Usage: ./restore-sessions.sh [backup-name]
# Example: ./restore-sessions.sh sessions-backup-20250105-143022

set -e

BACKUP_DIR="$(pwd)/backups"
SESSION_DIR="$(pwd)/sessions"

if [ -z "$1" ]; then
  echo "❌ Error: Please specify backup to restore"
  echo ""
  echo "Available backups:"
  ls -1t "$BACKUP_DIR"/sessions-backup-* 2>/dev/null || echo "  No backups found"
  echo ""
  echo "Usage: ./restore-sessions.sh [backup-name]"
  echo "Example: ./restore-sessions.sh sessions-backup-20250105-143022"
  exit 1
fi

BACKUP_NAME="$1"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"

if [ ! -d "$BACKUP_PATH" ]; then
  echo "❌ Error: Backup not found: $BACKUP_PATH"
  exit 1
fi

echo "⚠️  WARNING: This will replace current sessions with backup!"
echo "Backup: $BACKUP_NAME"
echo ""
read -p "Continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

# Backup current sessions before restoring (safety)
if [ -d "$SESSION_DIR" ] && [ -n "$(ls -A $SESSION_DIR 2>/dev/null)" ]; then
  echo "📦 Backing up current sessions first..."
  cp -r "$SESSION_DIR" "$BACKUP_DIR/sessions-before-restore-$(date +%Y%m%d-%H%M%S)"
fi

# Restore from backup
echo "🔄 Restoring sessions from backup..."
rm -rf "$SESSION_DIR"
cp -r "$BACKUP_PATH" "$SESSION_DIR"

echo "✅ Sessions restored successfully!"
echo ""
echo "⚠️  IMPORTANT: Restart the Baileys bridge now:"
echo "   pm2 restart velo-bridge-baileys"
