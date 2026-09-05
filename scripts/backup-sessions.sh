#!/bin/bash
# Automated session backup script
# Runs every 3 days via cron, keeps only 3 most recent backups

set -e  # Exit on error

BACKUP_DIR="$(pwd)/backups"
SESSION_DIR="$(pwd)/sessions"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_NAME="sessions-backup-$TIMESTAMP"

echo "🔄 Starting session backup..."

# Create backup directory if doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if sessions directory exists and has content
if [ ! -d "$SESSION_DIR" ] || [ -z "$(ls -A $SESSION_DIR 2>/dev/null)" ]; then
  echo "⚠️  No sessions to backup (empty or missing sessions/ folder)"
  exit 0
fi

# Create new backup
echo "📦 Creating backup: $BACKUP_NAME"
cp -r "$SESSION_DIR" "$BACKUP_DIR/$BACKUP_NAME"

if [ $? -eq 0 ]; then
  echo "✅ Backup created successfully"
else
  echo "❌ Backup failed"
  exit 1
fi

# Keep only the 3 most recent backups, delete the rest
echo "🧹 Cleaning old backups (keeping latest 3)..."
cd "$BACKUP_DIR"
ls -t sessions-backup-* 2>/dev/null | tail -n +4 | while read old_backup; do
  echo "   Deleting old backup: $old_backup"
  rm -rf "$old_backup"
done

# Show current backups
echo ""
echo "📁 Current backups:"
ls -lht sessions-backup-* 2>/dev/null | head -n 3 || echo "   No backups found"

echo ""
echo "✨ Backup complete!"
