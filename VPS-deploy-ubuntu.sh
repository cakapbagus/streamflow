#!/bin/bash

# =============================================================
#   StreamFlow - VPS Deploy Script (Ubuntu - Production)
#   Tested on: Ubuntu 20.04 / 22.04 / 24.04
# =============================================================

set -euo pipefail
IFS=$'\n\t'

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}  $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}\n"; }

# ── Require root ──────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Jalankan script ini sebagai root: sudo bash $0"

# =============================================================
#   KONFIGURASI — edit bagian ini sesuai kebutuhan
# =============================================================

APP_NAME="streamflow"
APP_PORT=7575
REPO_URL="https://github.com/cakapbagus/streamflow"
BRANCH="main"
TIMEZONE="Asia/Jakarta"
NODE_VERSION="22"                            # LTS

# Domain & SSL (isi jika sudah punya domain, kosongkan untuk skip SSL)
DOMAIN="tv.kodein.sch.id"                    # contoh: stream.domain.com
SSL_EMAIL="kodein.domain@gmail.com"          # contoh: admin@domain.com

# User yang menjalankan app:
# - Default: user yang memanggil sudo (SUDO_USER), atau "root" jika langsung login root
# - Ganti manual jika perlu, contoh: RUN_AS_USER="admin"
RUN_AS_USER="${SUDO_USER:-root}"
RUN_AS_HOME=$(eval echo "~$RUN_AS_USER")
APP_DIR="$RUN_AS_HOME/streamflow"

# =============================================================
#   INTERAKTIF — tanya konfigurasi jika belum diset
# =============================================================
header "StreamFlow VPS Installer"
info "App akan dijalankan sebagai user: ${BOLD}$RUN_AS_USER${NC}"
info "Direktori install: ${BOLD}$APP_DIR${NC}"
echo

if [[ -z "$DOMAIN" ]]; then
  read -rp "Domain (kosongkan untuk pakai IP saja): " DOMAIN
fi
if [[ -n "$DOMAIN" && -z "$SSL_EMAIL" ]]; then
  read -rp "Email untuk SSL Let's Encrypt: " SSL_EMAIL
fi

# =============================================================
#   1. SYSTEM UPDATE
# =============================================================
header "1. System Update"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl wget git unzip ufw fail2ban logrotate gnupg2 lsb-release ca-certificates
success "System updated"

# =============================================================
#   2. TIMEZONE
# =============================================================
header "2. Timezone"
timedatectl set-timezone "$TIMEZONE"
success "Timezone → $TIMEZONE"

# =============================================================
#   3. NODE.JS
# =============================================================
header "3. Node.js v$NODE_VERSION"
if command -v node &>/dev/null; then
  CURRENT_NODE=$(node -v | cut -dv -f2 | cut -d. -f1)
  if [[ "$CURRENT_NODE" -ge "$NODE_VERSION" ]]; then
    success "Node.js sudah terinstall: $(node -v)"
  else
    warn "Node.js $(node -v) terlalu lama — upgrade ke v$NODE_VERSION..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
    apt-get install -y nodejs
    success "Node.js upgraded: $(node -v)"
  fi
else
  curl -fsSL "https://deb.nodesource.com/setup_lts.x" | bash -
  apt-get install -y nodejs
  success "Node.js installed: $(node -v)"
fi

# =============================================================
#   4. FFMPEG
# =============================================================
header "4. FFmpeg"
if command -v ffmpeg &>/dev/null; then
  success "FFmpeg sudah terinstall: $(ffmpeg -version 2>&1 | head -1)"
else
  apt-get install -y ffmpeg
  success "FFmpeg installed: $(ffmpeg -version 2>&1 | head -1)"
fi

# =============================================================
#   5. PM2
# =============================================================
header "5. PM2"
if command -v pm2 &>/dev/null; then
  success "PM2 sudah terinstall: $(pm2 --version)"
else
  npm install -g pm2
  success "PM2 installed: $(pm2 --version)"
fi

# =============================================================
#   6. NGINX
# =============================================================
header "6. Nginx"
if command -v nginx &>/dev/null; then
  success "Nginx sudah terinstall"
else
  apt-get install -y nginx
  systemctl enable nginx
  success "Nginx installed"
fi

# =============================================================
#   7. CLONE / UPDATE REPO
# =============================================================
header "7. Repository"
if [[ -d "$APP_DIR/.git" ]]; then
  info "Repo sudah ada — pull update..."
  sudo -u "$RUN_AS_USER" git -C "$APP_DIR" pull origin "$BRANCH"
  success "Repo updated"
else
  info "Clone repo ke $APP_DIR..."
  rm -rf "$APP_DIR"
  sudo -u "$RUN_AS_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  success "Repo cloned"
fi

# =============================================================
#   8. ENVIRONMENT (.env)
# =============================================================
header "8. Environment (.env)"
ENV_FILE="$APP_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  SESSION_SECRET=$(node -e "const c=require('crypto');console.log(c.randomBytes(64).toString('hex'))")
  cat > "$ENV_FILE" <<ENVEOF
NODE_ENV=production
PORT=$APP_PORT
SESSION_SECRET=$SESSION_SECRET
ENVEOF
  chown "$RUN_AS_USER":"$RUN_AS_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  success ".env dibuat dengan SESSION_SECRET baru"
else
  if ! grep -q "NODE_ENV=production" "$ENV_FILE"; then
    sed -i 's/NODE_ENV=.*/NODE_ENV=production/' "$ENV_FILE" 2>/dev/null \
      || echo "NODE_ENV=production" >> "$ENV_FILE"
    success ".env: NODE_ENV → production"
  else
    success ".env sudah ada, tidak ditimpa"
  fi
fi

# =============================================================
#   9. NPM INSTALL
# =============================================================
header "9. Dependencies"
sudo -u "$RUN_AS_USER" bash -c "cd '$APP_DIR' && npm install --omit=dev --no-fund --no-audit"
success "npm install selesai"

# =============================================================
#   10. DIREKTORI & PERMISSIONS
# =============================================================
header "10. Direktori upload"
for DIR in \
  "$APP_DIR/public/uploads/videos" \
  "$APP_DIR/public/uploads/thumbnails" \
  "$APP_DIR/public/uploads/audio" \
  "$APP_DIR/public/uploads/logos" \
  "$APP_DIR/public/uploads/chunks" \
  "$APP_DIR/db" \
  "$APP_DIR/logs"; do
  mkdir -p "$DIR"
done
chown -R "$RUN_AS_USER":"$RUN_AS_USER" "$APP_DIR"
chmod -R 755 "$APP_DIR/public/uploads"
success "Direktori siap"

# =============================================================
#   11. PM2 ECOSYSTEM
# =============================================================
header "11. PM2 Ecosystem"
cat > "$APP_DIR/ecosystem.config.js" <<ECOEOF
module.exports = {
  apps: [{
    name: '$APP_NAME',
    script: 'app.js',
    cwd: '$APP_DIR',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: $APP_PORT
    },
    error_file: '$APP_DIR/logs/pm2-error.log',
    out_file: '$APP_DIR/logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
ECOEOF
chown "$RUN_AS_USER":"$RUN_AS_USER" "$APP_DIR/ecosystem.config.js"
success "ecosystem.config.js dibuat"

# Jalankan / restart app sebagai RUN_AS_USER
if sudo -u "$RUN_AS_USER" pm2 list 2>/dev/null | grep -q "$APP_NAME"; then
  sudo -u "$RUN_AS_USER" pm2 reload "$APP_NAME"
  success "App di-reload"
else
  sudo -u "$RUN_AS_USER" bash -c "cd '$APP_DIR' && pm2 start ecosystem.config.js"
  success "App started"
fi

sudo -u "$RUN_AS_USER" pm2 save
# Setup PM2 startup agar auto-start saat reboot
PM2_STARTUP_CMD=$(sudo -u "$RUN_AS_USER" pm2 startup systemd -u "$RUN_AS_USER" --hp "$RUN_AS_HOME" 2>/dev/null | grep "sudo env" || true)
if [[ -n "$PM2_STARTUP_CMD" ]]; then
  eval "$PM2_STARTUP_CMD"
fi
success "PM2 startup configured (auto-start saat reboot)"

# =============================================================
#   12. NGINX CONFIG
# =============================================================
header "12. Nginx Reverse Proxy"

NGINX_CONF="/etc/nginx/sites-available/$APP_NAME"
SERVER_NAME="${DOMAIN:-_}"

cat > "$NGINX_CONF" <<NGINXEOF
# StreamFlow - Nginx config
# Auto-generated by VPS-deploy-ubuntu.sh

client_max_body_size 20M;

server {
    listen 80;
    server_name $SERVER_NAME;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_min_length 1024;

    # Proxy ke Node.js
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
        proxy_send_timeout 300s;
    }

    # Upload chunked — timeout panjang, tanpa buffering
    location /api/upload {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # Static files — cache lama
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)\$ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
NGINXEOF

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
success "Nginx configured"

# =============================================================
#   13. SSL (Let's Encrypt) — hanya jika domain diisi
# =============================================================
header "13. SSL / HTTPS"
if [[ -n "$DOMAIN" && -n "$SSL_EMAIL" ]]; then
  if ! command -v certbot &>/dev/null; then
    apt-get install -y certbot python3-certbot-nginx
  fi
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$SSL_EMAIL" --redirect
  systemctl enable certbot.timer 2>/dev/null || true
  success "SSL aktif untuk $DOMAIN"
else
  warn "DOMAIN tidak diisi — SSL dilewati. App bisa diakses via HTTP."
fi

# =============================================================
#   14. FIREWALL (UFW)
# =============================================================
header "14. Firewall (UFW)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow http
ufw allow https
ufw allow "$APP_PORT/tcp"   # fallback akses langsung tanpa Nginx
ufw --force enable
success "UFW configured"
ufw status numbered

# =============================================================
#   15. FAIL2BAN
# =============================================================
header "15. Fail2ban"
systemctl enable fail2ban
systemctl start fail2ban
success "Fail2ban active"

# =============================================================
#   16. LOG ROTATION
# =============================================================
header "16. Log Rotation"
cat > /etc/logrotate.d/streamflow <<LOGEOF
$APP_DIR/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 640 $RUN_AS_USER $RUN_AS_USER
    sharedscripts
    postrotate
        su - $RUN_AS_USER -c "pm2 reloadLogs" 2>/dev/null || true
    endscript
}
LOGEOF
success "Log rotation configured (14 hari)"

# =============================================================
#   [OPSIONAL] USER NON-ROOT TERPISAH
#   Hapus komentar blok di bawah jika ingin membuat user
#   khusus (selain admin) untuk keamanan tambahan.
# =============================================================
# EXTRA_USER="streamflow-svc"
# if ! id "$EXTRA_USER" &>/dev/null; then
#   useradd --system --shell /bin/false "$EXTRA_USER"
#   usermod -aG "$EXTRA_USER" "$RUN_AS_USER"
#   success "User '$EXTRA_USER' dibuat"
# fi

# =============================================================
#   SELESAI
# =============================================================
SERVER_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║        DEPLOY SELESAI!                   ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${NC}"
echo
if [[ -n "$DOMAIN" ]]; then
  echo -e "  ${BOLD}URL:${NC}        https://$DOMAIN"
fi
echo -e "  ${BOLD}URL IP:${NC}     http://$SERVER_IP"
echo -e "  ${BOLD}Port langsung:${NC} http://$SERVER_IP:$APP_PORT"
echo -e "  ${BOLD}User:${NC}       $RUN_AS_USER"
echo -e "  ${BOLD}App dir:${NC}    $APP_DIR"
echo
echo -e "  ${BOLD}PM2 status:${NC}  pm2 status"
echo -e "  ${BOLD}PM2 logs:${NC}    pm2 logs $APP_NAME"
echo -e "  ${BOLD}Restart:${NC}     pm2 restart $APP_NAME"
echo -e "  ${BOLD}Update app:${NC}  cd $APP_DIR && git pull && npm install --omit=dev && pm2 restart $APP_NAME"
echo
echo -e "  ${BOLD}Langkah selanjutnya:${NC}"
echo -e "  1. Buka URL di browser"
echo -e "  2. Buat akun pertama (admin)"
echo -e "  3. Sign Out lalu login kembali untuk sinkronisasi database"
echo
