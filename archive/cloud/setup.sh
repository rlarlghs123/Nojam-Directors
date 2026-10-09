#!/usr/bin/env bash
# Nojam Archive on an always-on cloud server running Ubuntu 22.04 or 24.04. Made for Oracle Cloud's free
# Ampere (ARM) server; the step-by-step guide is cloud/README.md. On the server, run:
#
#   curl -fsSL https://raw.githubusercontent.com/rlarlghs123/Nojam-Directors/main/archive/cloud/setup.sh | bash
#
# It installs Docker and Tailscale, starts the archive with the free Ollama tagger, and makes the page reachable
# from your own devices only: through Tailscale, with HTTPS, never on the open internet.
# Run the same line again to update. Your files, tags and settings stay.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/rlarlghs123/Nojam-Directors.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-$HOME/Nojam-Directors}"
TS_NAME="${TS_NAME:-nojam-archive}"   # the server's name in Tailscale: https://nojam-archive.<your-tailnet>.ts.net
DEFAULT_MODEL="qwen3-vl:4b-instruct"  # about a minute per picture on 4 ARM cores; the 8b model is better but slower

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# A new server spends its first minutes installing Ubuntu's own updates; wait for them instead of failing.
apt_get() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -y -q "$@" && return 0
    echo "Ubuntu is busy updating itself; trying again in 30 seconds…"
    sleep 30
  done
  return 1
}
trap 'printf "\n\033[1mSomething went wrong (line %s). Read the message above, then run the same line again.\033[0m\n" "$LINENO"' ERR

# Read only what's needed from /etc/os-release (it defines NAME, VERSION and more, which would clash).
OS_ID="$(. /etc/os-release && echo "${ID:-}")"
CODENAME="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
if [ "$OS_ID" != ubuntu ] || [ -z "$CODENAME" ]; then
  echo "This script is for Ubuntu. Create the server with the image 'Canonical Ubuntu 24.04'."
  exit 1
fi
ME="$(id -un)"
OWNER="$(id -u):$(id -g)"

step "1/5  Installing Docker and Tailscale"
apt_get update
apt_get install ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$CODENAME.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
sudo curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$CODENAME.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
apt_get update
apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin tailscale
sudo systemctl enable --now docker tailscaled
sudo usermod -aG docker "$ME" # lets you use `docker` without sudo from your next login

step "2/5  Getting the archive"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" merge -q --ff-only "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR/archive"

step "3/5  Settings"
if [ ! -f .env ]; then
  cat >.env <<EOF
# Nojam Archive settings, written by cloud/setup.sh. After changing something, run the setup line again.
ARCHIVE_TITLE="Nojam Archive"
TAGGER=ollama
TAG_MODEL=$DEFAULT_MODEL
# Only this server can open the page; Tailscale brings it to your own devices.
ARCHIVE_BIND=127.0.0.1
# Files the archive writes belong to you ($ME), so you can copy them in and out.
ARCHIVE_USER=$OWNER
EOF
  echo "Wrote $DIR/archive/.env"
fi
# Never let an edited settings file put the page on the open internet.
grep -q '^ARCHIVE_BIND=' .env || echo 'ARCHIVE_BIND=127.0.0.1' >>.env
grep -q '^ARCHIVE_USER=' .env || echo "ARCHIVE_USER=$OWNER" >>.env
MODEL="$(sed -n 's/^TAG_MODEL=\([^#]*\).*/\1/p' .env | tail -n 1 | tr -d "\"' ")"
MODEL="${MODEL:-$DEFAULT_MODEL}"
mkdir -p library data ollama
sudo chown -R "$OWNER" library data

step "4/5  Starting the archive and the free tagger (the first time takes a few minutes)"
sudo docker compose up -d --build --remove-orphans
for _ in $(seq 90); do
  sudo docker compose exec -T ollama ollama list >/dev/null 2>&1 && break
  sleep 2
done
echo "Downloading the tagging model $MODEL (a few GB, only the first time)…"
sudo docker compose exec -T ollama ollama pull "$MODEL"

step "5/5  Connecting to Tailscale, your private way in"
if ! sudo tailscale status >/dev/null 2>&1; then
  echo "Open the link that appears below on your Mac or iPhone, and sign in to your Tailscale account."
  sudo tailscale up --hostname="$TS_NAME"
fi
# If Tailscale asks you to turn on HTTPS for your network, open its link and approve; it continues by itself.
sudo tailscale serve --bg 3000
URL="$(sudo tailscale serve status 2>/dev/null | grep -o 'https://[^ ]*' | head -n 1 || true)"

step "Done"
echo "Your archive: ${URL:-https://$TS_NAME.<your-tailnet>.ts.net}"
echo "Open it on any phone or computer where the Tailscale app is on and signed in to the same account."
echo "Disk space left on this server: $(df -h --output=avail / | tail -n 1 | tr -d ' ')"
