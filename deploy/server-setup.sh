#!/usr/bin/env bash
# Hosts the Brewzy POS website on an Ubuntu server (e.g. an Oracle Cloud
# Always Free VM) with nginx and HTTPS on your own domain. The data stays in
# Supabase; this only serves the website files.
#
#   bash server-setup.sh pos.example.com you@example.com
#
# Before running: point the domain's DNS "A" record at this server's public IP,
# and open ports 80 and 443 (Oracle: VCN -> Security List -> Ingress rules).
# Safe to re-run. The site updates itself from GitHub every 5 minutes.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
[[ -z "$DOMAIN" ]] && read -rp "Domain for the POS (e.g. pos.example.com): " DOMAIN
[[ -z "$EMAIL" ]] && read -rp "Email for HTTPS certificate notices: " EMAIL
REPO="https://github.com/alisamah22/brewzy-pos.git"
BRANCH="main"
WEB="/var/www/brewzy-pos"
SITE="/etc/nginx/sites-available/brewzy-pos"

echo "==> Installing nginx, certbot and git"
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx git

echo "==> Opening ports 80 and 443 in the server firewall"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save; fi

echo "==> Getting the POS files from GitHub"
if [[ -d "$WEB/.git" ]]; then
  sudo git -C "$WEB" fetch --quiet origin "$BRANCH"
  sudo git -C "$WEB" reset --quiet --hard "origin/$BRANCH"
else
  sudo git clone --quiet --branch "$BRANCH" "$REPO" "$WEB"
fi

echo "==> Configuring nginx for $DOMAIN"
sudo tee "$SITE" > /dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    root $WEB;
    index index.html;

    # Only the website: no repository, database scripts or tests.
    location ~ /\\.          { deny all; }
    location ^~ /supabase/   { deny all; }
    location ^~ /deploy/     { deny all; }
    location ^~ /tests/      { deny all; }
    location ~ \\.(md|sh)$   { deny all; }

    # The page is always fresh; its scripts and styles carry ?v= versions.
    location = /index.html { add_header Cache-Control "no-cache"; }
    location ~* \\.(js|css)$ { add_header Cache-Control "public, max-age=604800"; }

    location / { try_files \$uri \$uri/ /index.html; }

    gzip on;
    gzip_types text/css application/javascript;
}
NGINX
sudo ln -sf "$SITE" /etc/nginx/sites-enabled/brewzy-pos
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

echo "==> Keeping the site up to date (checks GitHub every 5 minutes)"
sudo tee /etc/systemd/system/brewzy-pos-update.service > /dev/null <<UNIT
[Unit]
Description=Update the Brewzy POS website from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/git -C $WEB fetch --quiet origin $BRANCH
ExecStart=/usr/bin/git -C $WEB reset --quiet --hard origin/$BRANCH
UNIT
sudo tee /etc/systemd/system/brewzy-pos-update.timer > /dev/null <<UNIT
[Unit]
Description=Update the Brewzy POS website from GitHub every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now brewzy-pos-update.timer

echo "==> HTTPS certificate"
server_ip="$(curl -s https://api.ipify.org || true)"
domain_ip="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)"
if [[ -n "$server_ip" && "$server_ip" == "$domain_ip" ]]; then
  sudo certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect --non-interactive
  echo
  echo "Done: https://$DOMAIN"
else
  echo
  echo "The site works at http://$server_ip but $DOMAIN points to '${domain_ip:-nothing}', not this server ($server_ip)."
  echo "Set the domain's A record to $server_ip, wait a few minutes, then run this script again for HTTPS."
fi
