#!/usr/bin/env bash
#
# Koda installer — install the Koda daemon via npm.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kfuras/koda/main/install.sh | bash
#
# Flags:
#   --no-onboard       Skip `koda init` + `koda doctor`
#   --skip-prereqs     Don't auto-install Node/pm2
#   --dry-run          Print the plan without executing
#   --help, -h         Show this message
#
# What this script installs if missing:
#   - Homebrew (macOS only)
#   - Node.js 18+
#   - pm2 (global npm package)
#   - koda-agent (global npm package)
#
# It will NOT:
#   - Modify your shell rc files
#   - Run sudo on macOS
#   - Touch ~/.koda/ (your state and config stay untouched)
#

set -euo pipefail

# ===== Colors =====
if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[0;31m' GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m' BLUE=$'\033[0;34m' CYAN=$'\033[0;36m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" CYAN="" RESET=""
fi

# ===== Defaults =====
NO_ONBOARD=0
SKIP_PREREQS=0
DRY_RUN=0

# ===== Helpers =====
info()  { echo "  ${BLUE}→${RESET} $*"; }
ok()    { echo "  ${GREEN}✓${RESET} $*"; }
warn()  { echo "  ${YELLOW}⚠${RESET} $*"; }
err()   { echo "  ${RED}✗${RESET} $*" >&2; }
stage() { echo; echo "${BOLD}${CYAN}▸ $*${RESET}"; }
die()   { err "$*"; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    ${DIM}[dry-run]${RESET} $*"
  else
    "$@"
  fi
}

# ===== Parse args =====
while [ $# -gt 0 ]; do
  case "$1" in
    --no-onboard)   NO_ONBOARD=1; shift ;;
    --skip-prereqs) SKIP_PREREQS=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --help|-h)
      awk '/^#/{print; next} {exit}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown argument: $1 (use --help)" ;;
  esac
done

# ===== Banner =====
echo
echo "${BOLD}${CYAN}╭────────────────────────────╮${RESET}"
echo "${BOLD}${CYAN}│     Koda installer         │${RESET}"
echo "${BOLD}${CYAN}╰────────────────────────────╯${RESET}"

# ===== Detect OS =====
stage "Detecting OS"
OS="unknown"
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)      die "Unsupported OS: $(uname -s). Koda supports macOS and Linux." ;;
esac
ok "OS: $OS"

# ===== Prerequisites =====
stage "Checking prerequisites"

# Homebrew (macOS only)
if [ "$OS" = "macos" ]; then
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew: $(command -v brew)"
  elif [ "$SKIP_PREREQS" -eq 0 ]; then
    info "Installing Homebrew"
    run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
    [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

# Node.js 18+
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -v | sed 's/v//' | cut -d. -f1)"
  [ -n "$v" ] && [ "$v" -ge 18 ] 2>/dev/null
}

if node_ok; then
  ok "Node.js: $(node -v)"
elif [ "$SKIP_PREREQS" -eq 0 ]; then
  info "Installing Node.js"
  if [ "$OS" = "macos" ]; then
    run brew install node@22 && run brew link --force --overwrite node@22 2>/dev/null || true
  elif command -v apt-get >/dev/null 2>&1; then
    run sudo apt-get update && run sudo apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    run sudo dnf install -y nodejs npm
  fi
  node_ok || die "Node.js 18+ install failed. Install manually and re-run."
  ok "Node.js: $(node -v)"
else
  die "Node.js 18+ not found and --skip-prereqs set"
fi

# pm2
if command -v pm2 >/dev/null 2>&1; then
  ok "pm2: installed"
elif [ "$SKIP_PREREQS" -eq 0 ]; then
  info "Installing pm2"
  run npm install -g pm2 || warn "pm2 install failed — run 'npm install -g pm2' manually"
fi

# ===== Install koda-agent from npm =====
stage "Installing koda-agent"

if command -v koda >/dev/null 2>&1; then
  CURRENT_VER="$(koda --version 2>/dev/null || echo unknown)"
  info "Koda already installed: $CURRENT_VER — updating"
  run npm install -g koda-agent@latest
else
  run npm install -g koda-agent
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "${BOLD}${GREEN}Dry run complete — no changes made.${RESET}"
  echo
  exit 0
fi

if command -v koda >/dev/null 2>&1; then
  ok "koda command: $(command -v koda)"
  ok "version: $(koda --version 2>/dev/null || echo unknown)"
else
  warn "'koda' not in PATH — open a new shell or: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
fi

# ===== koda init =====
if [ "$NO_ONBOARD" -eq 0 ]; then
  stage "Setting up ~/.koda/"
  if command -v koda >/dev/null 2>&1; then
    koda init || warn "koda init reported issues (see above)"
  fi

  stage "Running koda doctor"
  if command -v koda >/dev/null 2>&1; then
    koda doctor || warn "koda doctor reported issues (see above)"
  fi
fi

# ===== Daemon refresh =====
if command -v pm2 >/dev/null 2>&1; then
  if pm2 jlist 2>/dev/null | grep -q '"name":"koda"'; then
    stage "Restarting Koda daemon"
    pm2 restart koda --update-env && ok "Daemon restarted" || warn "pm2 restart failed"
  fi
fi

# ===== Done =====
echo
echo "${BOLD}${GREEN}╭────────────────────────────╮${RESET}"
echo "${BOLD}${GREEN}│    Koda installed           │${RESET}"
echo "${BOLD}${GREEN}╰────────────────────────────╯${RESET}"
echo
echo "${BOLD}Binary:${RESET}  $(command -v koda 2>/dev/null || echo '(open a new shell)')"
echo
if [ ! -d "$HOME/.koda" ]; then
  echo "${BOLD}Next steps:${RESET}"
  echo "  1. koda init                             Set up ~/.koda/"
  echo "  2. Edit ~/.koda/config.json              Your name, model, budgets"
  echo "  3. Edit ~/.koda/.env                     API keys and tokens"
  echo "  4. koda doctor                           Verify setup"
  echo "  5. pm2 start \$(npm root -g)/koda-agent/ecosystem.config.cjs"
  echo "  6. koda status"
else
  echo "${BOLD}Commands:${RESET}"
  echo "  koda status        — see what's running"
  echo "  koda update        — pull latest and restart"
  echo "  koda logs          — tail daemon logs"
  echo "  koda --help        — all commands"
fi
echo
