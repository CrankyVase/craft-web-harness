#!/usr/bin/env bash
# Installs the harness as user systemd units: the server, plus an hourly app updater.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { umask 077; printf 'PORT=8480\nHOST=0.0.0.0\nHARNESS_USER=craft\nHARNESS_PASS=%s\n' "$(openssl rand -base64 18 | tr -d '/+=')" > .env; echo "Created .env with a random password"; }
node scripts/update.mjs || true
mkdir -p ~/.config/systemd/user
cp systemd/*.service systemd/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now craft-harness.service craft-harness-update.timer
echo "Running on port $(grep ^PORT= .env | cut -d= -f2)"
