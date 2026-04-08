#!/usr/bin/env bash
#
# Koda installer — install and update the Koda daemon.
#
# Fresh install (from anywhere):
#   cd ~/wherever-you-want-koda
#   curl -fsSL https://raw.githubusercontent.com/kfuras/koda/main/install.sh | bash
#
# This creates a `koda` subdirectory at your current location ($PWD/koda).
# You choose the parent directory by cd-ing first.
#
# If you run this from inside an existing koda checkout, it uses that
# checkout instead of cloning a new one.
#
# Flags:
#   --no-onboard       Skip the `koda doctor` step (useful for CI)
#   --skip-prereqs     Don't auto-install Homebrew/Node/git/pm2
#   --dry-run          Print the plan without executing anything
#   --help, -h         Show this message
#
# What this script will install if missing (on macOS via Homebrew, on Linux
# via your package manager):
#   - Homebrew (macOS only)
#   - Node.js 18+ (recommend Node 22)
#   - Git
#   - pm2 (via npm install -g)
#
# It will NOT:
#   - Modify your shell rc files
#   - Run sudo on macOS (only on Linux, and only for package manager installs)
#   - Touch ~/.koda/ (your state and config stay untouched)
#   - Install to /usr/local/bin directly (uses `npm link` which respects
#     your npm prefix)
#

set -euo pipefail

# ===== Colors (plain output if not a TTY) =====
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'
  CYAN=$'\033[0;36m'
  RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; RESET=""
fi

# ===== Defaults =====
NO_ONBOARD=0
SKIP_PREREQS=0
DRY_RUN=0
REPO_URL="https://github.com/kfuras/koda.git"
REPO_DIRNAME="koda"

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
    *)
      die "Unknown argument: $1 (use --help)"
      ;;
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
  *)      die "Unsupported OS: $(uname -s). Koda supports macOS and Linux only." ;;
esac
ok "OS: $OS"

# ===== Prerequisite: Homebrew (macOS only) =====
install_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew installed: $(command -v brew)"
    return 0
  fi
  if [ "$SKIP_PREREQS" -eq 1 ]; then
    die "Homebrew not found and --skip-prereqs set. Install from https://brew.sh"
  fi
  info "Homebrew not found — installing (this may prompt for password)"
  run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Activate brew for this session
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  ok "Homebrew installed"
}

# ===== Prerequisite: Node.js 18+ =====
node_version_ok() {
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  local v
  v="$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)"
  [ -n "$v" ] && [ "$v" -ge 18 ] 2>/dev/null
}

install_node() {
  if node_version_ok; then
    ok "Node.js: $(node -v)"
    return 0
  fi
  if [ "$SKIP_PREREQS" -eq 1 ]; then
    die "Node.js 18+ not found and --skip-prereqs set"
  fi
  info "Node.js 18+ not found — installing"
  if [ "$OS" = "macos" ]; then
    run brew install node@22
    run brew link --force --overwrite node@22 2>/dev/null || true
  elif [ "$OS" = "linux" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      run sudo apt-get update
      run sudo apt-get install -y nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
      run sudo dnf install -y nodejs npm
    elif command -v yum >/dev/null 2>&1; then
      run sudo yum install -y nodejs npm
    else
      die "No supported package manager (apt/dnf/yum). Install Node.js 18+ manually."
    fi
  fi
  if [ "$DRY_RUN" -eq 0 ] && ! node_version_ok; then
    die "Node.js 18+ install did not succeed. Install manually and re-run."
  fi
  ok "Node.js: ${DRY_RUN:+(dry-run)}$(node -v 2>/dev/null || echo pending)"
}

# ===== Prerequisite: Git =====
install_git() {
  if command -v git >/dev/null 2>&1; then
    ok "git: $(git --version | awk '{print $3}')"
    return 0
  fi
  if [ "$SKIP_PREREQS" -eq 1 ]; then
    die "git not found and --skip-prereqs set"
  fi
  info "git not found — installing"
  if [ "$OS" = "macos" ]; then
    run brew install git
  elif [ "$OS" = "linux" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      run sudo apt-get install -y git
    elif command -v dnf >/dev/null 2>&1; then
      run sudo dnf install -y git
    elif command -v yum >/dev/null 2>&1; then
      run sudo yum install -y git
    fi
  fi
  ok "git installed"
}

# ===== Prerequisite: pm2 =====
install_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    ok "pm2: installed"
    return 0
  fi
  if [ "$SKIP_PREREQS" -eq 1 ]; then
    warn "pm2 not found — install later with: npm install -g pm2"
    return 0
  fi
  info "pm2 not found — installing globally via npm"
  run npm install -g pm2 || warn "pm2 install failed — run 'npm install -g pm2' manually"
}

# ===== Run prereq installs =====
stage "Checking prerequisites"
if [ "$OS" = "macos" ]; then install_homebrew; fi
install_node
install_git
install_pm2

# ===== Detect existing checkout or choose clone target =====
stage "Locating Koda repo"

detect_existing_checkout() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ] && grep -q '"name": "koda-agent"' "$dir/package.json" 2>/dev/null; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

KODA_DIR=""
existing="$(detect_existing_checkout || true)"
if [ -n "$existing" ]; then
  KODA_DIR="$existing"
  ok "Found existing checkout: $KODA_DIR"
elif [ -d "$PWD/$REPO_DIRNAME" ]; then
  # $PWD/koda exists — check if it's a valid koda repo
  if [ -f "$PWD/$REPO_DIRNAME/package.json" ] && grep -q '"name": "koda-agent"' "$PWD/$REPO_DIRNAME/package.json" 2>/dev/null; then
    KODA_DIR="$PWD/$REPO_DIRNAME"
    ok "Found Koda at: $KODA_DIR"
  else
    die "$PWD/$REPO_DIRNAME exists but is not a Koda repo. Move it aside or cd elsewhere."
  fi
else
  KODA_DIR="$PWD/$REPO_DIRNAME"
  info "Will clone into: $KODA_DIR"
fi

# ===== Clone or pull =====
if [ -d "$KODA_DIR/.git" ]; then
  stage "Updating existing checkout"
  cd "$KODA_DIR"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    warn "Worktree has uncommitted changes — skipping git pull"
  else
    run git pull --ff-only origin main || warn "git pull failed; continuing with current state"
  fi
else
  stage "Cloning Koda"
  run git clone "$REPO_URL" "$KODA_DIR"
  if [ "$DRY_RUN" -eq 0 ]; then
    cd "$KODA_DIR"
  else
    info "(dry-run) would cd into $KODA_DIR and continue from there"
    echo
    echo "${BOLD}${GREEN}Dry run complete — no changes made.${RESET}"
    echo
    exit 0
  fi
fi

# ===== npm install =====
stage "Installing dependencies"
run npm install

# ===== Build =====
stage "Building Koda"
run npm run build

# ===== Link global binary =====
stage "Linking 'koda' command"
if [ "$DRY_RUN" -eq 1 ]; then
  run npm link
else
  if ! npm link; then
    if [ "$OS" = "linux" ]; then
      warn "npm link failed — retrying with sudo"
      sudo npm link || die "npm link failed even with sudo"
    else
      die "npm link failed"
    fi
  fi
fi

if [ "$DRY_RUN" -eq 0 ] && command -v koda >/dev/null 2>&1; then
  ok "koda command available: $(command -v koda)"
  ok "koda --version: $(koda --version 2>/dev/null || echo unknown)"
else
  warn "'koda' not in PATH yet — open a new shell or run: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
fi

# ===== Doctor =====
if [ "$NO_ONBOARD" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  stage "Running koda doctor"
  if command -v koda >/dev/null 2>&1; then
    koda doctor || warn "koda doctor reported issues (see above)"
  else
    warn "koda not in PATH — skipping doctor"
  fi
fi

# ===== Daemon refresh =====
if [ "$DRY_RUN" -eq 0 ] && command -v pm2 >/dev/null 2>&1; then
  if pm2 jlist 2>/dev/null | grep -q '"name":"koda"'; then
    stage "Restarting Koda daemon"
    pm2 restart koda --update-env && ok "Daemon restarted" || warn "pm2 restart failed"
  fi
fi

# ===== Next steps =====
echo
echo "${BOLD}${GREEN}╭────────────────────────────╮${RESET}"
echo "${BOLD}${GREEN}│    Koda installed          │${RESET}"
echo "${BOLD}${GREEN}╰────────────────────────────╯${RESET}"
echo
echo "${BOLD}Repo:${RESET}    $KODA_DIR"
echo "${BOLD}Binary:${RESET}  $(command -v koda 2>/dev/null || echo '(not in PATH — open a new shell)')"
echo
echo "${BOLD}Next steps:${RESET}"
if [ ! -d "$HOME/.koda" ]; then
  echo "  1. Set up ~/.koda/ with your config"
  echo "     (see $KODA_DIR/README.md for the expected layout)"
  echo "  2. cd $KODA_DIR && pm2 start ecosystem.config.cjs"
  echo "  3. koda status"
else
  echo "  • koda status        — see what's running"
  echo "  • koda update        — pull latest and restart"
  echo "  • koda logs          — tail daemon logs"
  echo "  • koda --help        — all commands"
  if command -v pm2 >/dev/null 2>&1 && ! pm2 jlist 2>/dev/null | grep -q '"name":"koda"'; then
    echo
    echo "  Daemon not running. Start with:"
    echo "    cd $KODA_DIR && pm2 start ecosystem.config.cjs"
  fi
fi
echo
