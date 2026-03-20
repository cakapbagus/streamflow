# Guide Deploy StreamFlow ke VPS Ubuntu

## Prasyarat

| Kebutuhan | Detail |
|---|---|
| VPS | Ubuntu 20.04 / 22.04 / 24.04 |
| RAM | Minimal 1 GB (rekomendasi 2 GB+) |
| Akses | SSH sebagai root atau user dengan sudo |
| Domain | Opsional (untuk HTTPS) |

---

## 1. Persiapan Sebelum Deploy

### Edit konfigurasi di script

Sebelum menjalankan script, buka `VPS-deploy-ubuntu.sh` dan sesuaikan bagian ini (baris 28–43):

```bash
APP_NAME="streamflow"
APP_PORT=7575
REPO_URL="https://github.com/cakapbagus/streamflow"
BRANCH="main"
TIMEZONE="Asia/Jakarta"
NODE_VERSION="22"

DOMAIN="tv.kodein.sch.id"        # Kosongkan jika pakai IP saja: DOMAIN=""
SSL_EMAIL="admin@domain.com"     # Email untuk sertifikat Let's Encrypt
```

> Jika `DOMAIN` dikosongkan, SSL akan dilewati dan app hanya bisa diakses via HTTP.

---

## 2. Upload & Jalankan Script

### Opsi A — Clone langsung di VPS

```bash
# SSH ke VPS
ssh root@IP_VPS

# Download script
curl -O https://raw.githubusercontent.com/cakapbagus/streamflow/main/VPS-deploy-ubuntu.sh

# Beri izin eksekusi dan jalankan
chmod +x VPS-deploy-ubuntu.sh
sudo bash VPS-deploy-ubuntu.sh
```

### Opsi B — Upload dari lokal (Windows)

```powershell
# Di terminal Windows/PowerShell
scp VPS-deploy-ubuntu.sh root@IP_VPS:/root/
ssh root@IP_VPS "chmod +x VPS-deploy-ubuntu.sh && sudo bash VPS-deploy-ubuntu.sh"
```

---

## 3. Apa yang Dilakukan Script

Script berjalan otomatis melalui 16 langkah:

| Langkah | Aksi |
|---|---|
| 1 | Update sistem & install tools dasar |
| 2 | Set timezone ke `Asia/Jakarta` |
| 3 | Install Node.js v22 LTS |
| 4 | Install FFmpeg |
| 5 | Install PM2 (process manager) |
| 6 | Install Nginx |
| 7 | Clone repo dari GitHub |
| 8 | Buat file `.env` dengan `SESSION_SECRET` acak |
| 9 | `npm install --omit=dev` |
| 10 | Buat direktori upload & set permission |
| 11 | Konfigurasi PM2 + auto-start saat reboot |
| 12 | Konfigurasi Nginx sebagai reverse proxy |
| 13 | Install SSL Let's Encrypt (jika domain diisi) |
| 14 | Konfigurasi firewall UFW |
| 15 | Aktifkan Fail2ban |
| 16 | Setup log rotation (14 hari) |

---

## 4. Setelah Deploy Selesai

Script akan menampilkan output seperti ini:

```
URL:           https://tv.kodein.sch.id
URL IP:        http://YOUR_IP
Port langsung: http://YOUR_IP:7575
```

**Langkah selanjutnya:**
1. Buka URL di browser
2. Buat akun pertama (otomatis jadi admin)
3. Sign Out lalu login kembali (sinkronisasi database)

---

## 5. Perintah Sehari-hari

```bash
# Cek status app
pm2 status

# Lihat log real-time
pm2 logs streamflow

# Restart app
pm2 restart streamflow

# Update app ke versi terbaru
cd ~/streamflow && git pull && npm install --omit=dev && pm2 restart streamflow

# Cek status Nginx
systemctl status nginx

# Reload Nginx setelah edit config
nginx -t && systemctl reload nginx
```

---

## 6. Troubleshooting

**App tidak bisa diakses via browser:**
```bash
pm2 status          # pastikan status "online"
pm2 logs streamflow # cek error
ufw status          # pastikan port 80/443/7575 terbuka
```

**SSL gagal:**
- Pastikan domain sudah pointing ke IP VPS (cek dengan `dig yourdomain.com`)
- Pastikan port 80 terbuka sebelum certbot berjalan

**Re-run script (update/reinstall):**
Script aman dijalankan ulang — jika repo sudah ada, ia hanya melakukan `git pull`; jika `.env` sudah ada, tidak ditimpa.

---

## 7. Struktur File di VPS

```
~/streamflow/
├── app.js
├── .env                    # credentials (chmod 600)
├── ecosystem.config.js     # konfigurasi PM2
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
