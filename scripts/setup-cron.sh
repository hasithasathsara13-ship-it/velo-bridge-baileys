#!/bin/bash
# Setup cron job for automated backups every 3 days
# Run this ONCE on your server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-sessions.sh"

echo "🔧 Setting up automated backup cron job..."

# Make scripts executable
chmod +x "$SCRIPT_DIR"/*.sh
echo "✅ Scripts made executable"

# Create cron job (runs every 3 days at 2 AM)
CRON_LINE="0 2 */3 * * cd $PROJECT_DIR && $BACKUP_SCRIPT >> $PROJECT_DIR/backup.log 2>&1"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "$BACKUP_SCRIPT"; then
  echo "⚠️  Cron job already exists, skipping..."
else
  # Add cron job
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "✅ Cron job added!"
fi

echo ""
echo "📅 Backup schedule: Every 3 days at 2:00 AM"
echo "📁 Backup location: $PROJECT_DIR/backups/"
echo "📝 Backup logs: $PROJECT_DIR/backup.log"
echo ""
echo "Current cron jobs:"
crontab -l | grep backup-sessions || echo "  No backup crons found"

echo ""
echo "✨ Setup complete!"
echo ""
echo "To manually trigger backup now:"
echo "  cd $PROJECT_DIR && ./scripts/backup-sessions.sh"
