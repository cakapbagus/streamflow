# StreamFlow VPS Deployment Guide (Ubuntu)

## Prerequisites

| Requirement | Details |
|---|---|
| VPS | Ubuntu 20.04 / 22.04 / 24.04 |
| RAM | Minimum 1 GB (2 GB+ recommended) |
| Access | SSH as root or user with sudo |
| Domain | Optional (for HTTPS) |

---

## 1. Pre-Deployment Setup

### Edit the script configuration

Before running the script, open `VPS-deploy-ubuntu.sh` and adjust this section (lines 28–43):

```bash
APP_NAME="streamflow"
APP_PORT=7575
REPO_URL="https://github.com/cakapbagus/streamflow"
BRANCH="main"
TIMEZONE="Asia/Jakarta"
NODE_VERSION="22"

DOMAIN="tv.kodein.sch.id"        # Leave empty to use IP only: DOMAIN=""
SSL_EMAIL="admin@domain.com"     # Email for Let's Encrypt certificate
```

> If `DOMAIN` is left empty, SSL will be skipped and the app will only be accessible via HTTP.

---

## 2. Upload & Run the Script

### Option A — Clone directly on the VPS

```bash
# SSH into the VPS
ssh root@YOUR_VPS_IP

# Download the script
curl -O https://raw.githubusercontent.com/cakapbagus/streamflow/main/VPS-deploy-ubuntu.sh

# Grant execute permission and run
chmod +x VPS-deploy-ubuntu.sh
sudo bash VPS-deploy-ubuntu.sh
```

### Option B — Upload from local machine (Windows)

```powershell
# In Windows terminal / PowerShell
scp VPS-deploy-ubuntu.sh root@YOUR_VPS_IP:/root/
ssh root@YOUR_VPS_IP "chmod +x VPS-deploy-ubuntu.sh && sudo bash VPS-deploy-ubuntu.sh"
```

---

## 3. What the Script Does

The script runs automatically through 16 steps:

| Step | Action |
|---|---|
| 1 | Update system & install basic tools |
| 2 | Set timezone to `Asia/Jakarta` |
| 3 | Install Node.js v22 LTS |
| 4 | Install FFmpeg |
| 5 | Install PM2 (process manager) |
| 6 | Install Nginx |
| 7 | Clone repo from GitHub |
| 8 | Create `.env` file with a random `SESSION_SECRET` |
| 9 | `npm install --omit=dev` |
| 10 | Create upload directories & set permissions |
| 11 | Configure PM2 + auto-start on reboot |
| 12 | Configure Nginx as reverse proxy |
| 13 | Install Let's Encrypt SSL (if domain is provided) |
| 14 | Configure UFW firewall |
| 15 | Enable Fail2ban |
| 16 | Setup log rotation (14 days) |

---

## 4. After Deployment

The script will display output like this:

```
URL:          https://tv.kodein.sch.id
IP URL:       http://YOUR_IP
Direct port:  http://YOUR_IP:7575
```

**Next steps:**
1. Open the URL in your browser
2. Create the first account (automatically becomes admin)
3. Sign out then log back in (database sync)

---

## 5. Day-to-Day Commands

```bash
# Check app status
pm2 status

# View real-time logs
pm2 logs streamflow

# Restart the app
pm2 restart streamflow

# Update app to the latest version
cd ~/streamflow && git pull && npm install --omit=dev && pm2 restart streamflow

# Check Nginx status
systemctl status nginx

# Reload Nginx after editing config
nginx -t && systemctl reload nginx
```

---

## 6. Troubleshooting

**App not accessible via browser:**
```bash
pm2 status          # make sure status is "online"
pm2 logs streamflow # check for errors
ufw status          # make sure ports 80/443/7575 are open
```

**SSL failed:**
- Make sure the domain is pointing to the VPS IP (check with `dig yourdomain.com`)
- Make sure port 80 is open before certbot runs

**Re-run the script (update/reinstall):**
The script is safe to re-run — if the repo already exists, it only does a `git pull`; if `.env` already exists, it will not be overwritten.

---

## 7. File Structure on VPS

```
~/streamflow/
├── app.js
├── .env                    # credentials (chmod 600)
├── ecosystem.config.js     # PM2 configuration
├── logs/
│   ├── pm2-out.log
│   └── pm2-error.log
└── public/uploads/
    ├── videos/
    ├── thumbnails/
    ├── audio/
    ├── logos/
    └── chunks/
```
