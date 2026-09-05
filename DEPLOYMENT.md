# 🚀 Deployment Guide (Zero-Downtime + Session Preservation)

# SSH into server
ssh ubuntu@your-server

# Navigate and deploy
cd /home/ubuntu/velo-bridge-baileys
git pull origin main
npm run build
pm2 reload velo-bridge-baileys







## 📋 Overview

This guide ensures **100+ businesses stay connected** through code updates without rescanning QR codes.

---

## 🎯 Key Features

- ✅ **Automated backups** every 3 days
- ✅ **Keeps only 3 latest backups** (auto-cleanup)
- ✅ **Zero-downtime deployments**
- ✅ **Sessions preserved across updates**
- ✅ **Works with Zeabur auto-deploy**

---

## 📦 Initial Setup (Run Once)

### 1. Make scripts executable

```bash
cd /path/to/velo-bridge-baileys
chmod +x scripts/*.sh
```

### 2. Setup automated backups (every 3 days)

```bash
./scripts/setup-cron.sh
```

This creates a cron job that:
- Runs every 3 days at 2:00 AM
- Backs up `sessions/` folder
- Keeps only 3 most recent backups
- Logs to `backup.log`

### 3. Verify cron is working

```bash
crontab -l
# Should show: 0 2 */3 * * cd /path/to/velo-bridge-baileys && ...
```

---

## 🔄 Deployment Methods

### Method 1: Zeabur Auto-Deploy (Recommended)

**Zeabur automatically deploys when you push to GitHub.**

1. Push code:
   ```bash
   git push origin main
   ```

2. Zeabur detects changes and:
   - Pulls latest code
   - Runs `npm install` (if needed)
   - Runs `npm run build`
   - Restarts service
   - **Sessions preserved automatically!** ✅

3. Verify all businesses still connected:
   ```bash
   curl https://your-baileys-instance.zeabur.app/session/all
   ```

**⚠️ IMPORTANT**: Make sure `sessions/` folder is **PERSISTENT** in Zeabur:
- Go to Zeabur Dashboard → Your Service → Storage
- Add persistent volume: `/app/sessions` → This prevents session loss on redeploy

---

### Method 2: Manual Deploy Script

If you need manual control:

```bash
cd /path/to/velo-bridge-baileys
./scripts/deploy.sh
```

This script:
1. Checks for existing sessions
2. Pulls latest code
3. Installs dependencies (if needed)
4. Builds TypeScript
5. Gracefully restarts (zero downtime)
6. Preserves all sessions

---

## 🛡️ Backup Management

### Manual Backup (Before Risky Changes)

```bash
./scripts/backup-sessions.sh
```

Creates backup in `backups/sessions-backup-TIMESTAMP/`

### View All Backups

```bash
ls -lht backups/
```

Shows backups sorted by date (newest first).

### Restore from Backup (Emergency)

```bash
./scripts/restore-sessions.sh sessions-backup-20250105-143022
```

**⚠️ WARNING**: This replaces current sessions! Only use if:
- Deployment broke all sessions
- Need to rollback to previous state

After restore, restart Baileys:
```bash
pm2 restart velo-bridge-baileys
# OR let Zeabur auto-restart
```

---

## 📊 Monitoring

### Check Backup Logs

```bash
tail -f backup.log
```

### View Session Count

```bash
ls -1 sessions/ | wc -l
```

Shows number of connected businesses.

### Check Latest Backup

```bash
ls -lt backups/ | head -n 2
```

---

## 🔥 Troubleshooting

### Sessions Lost After Deploy

1. Check if `sessions/` folder exists:
   ```bash
   ls -la sessions/
   ```

2. Restore from latest backup:
   ```bash
   ./scripts/restore-sessions.sh $(ls -t backups/ | head -n 1)
   ```

3. Restart Baileys

### Zeabur Keeps Deleting Sessions

**Problem**: Zeabur ephemeral storage

**Solution**: Add persistent volume in Zeabur:
1. Dashboard → Service → Storage
2. Add Volume: `/app/sessions`
3. This mounts `sessions/` to persistent disk

### Cron Not Running

1. Check cron status:
   ```bash
   systemctl status cron
   ```

2. Check cron logs:
   ```bash
   grep CRON /var/log/syslog
   ```

3. Manually test backup:
   ```bash
   ./scripts/backup-sessions.sh
   ```

---

## 📝 Best Practices

### ✅ DO:
- Let automated backups run (every 3 days)
- Use `./scripts/deploy.sh` for manual deploys
- Keep `sessions/` in persistent storage (Zeabur)
- Test restore process occasionally

### ❌ DON'T:
- Don't delete `sessions/` folder manually
- Don't use `pm2 restart` (use `pm2 reload` for zero downtime)
- Don't backup on every deploy (wastes space)
- Don't commit `sessions/` or `backups/` to Git

---

## 🎯 Production Checklist

Before going live with 100+ businesses:

- [ ] Persistent storage configured in Zeabur
- [ ] Automated backups setup (cron running)
- [ ] Test manual backup/restore once
- [ ] Test Zeabur auto-deploy (push dummy change)
- [ ] Verify sessions preserved after deploy
- [ ] Monitor `backup.log` for first week

---

## 📞 Emergency Contacts

If sessions are lost and backups fail:
1. Businesses will need to rescan QR codes
2. Go to Messages page → Click "Connect WhatsApp"
3. Share QR code with business owners

**This should NEVER happen with proper setup!**
