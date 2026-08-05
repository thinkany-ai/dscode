#!/bin/sh
#
# DSCode one-click installer
#
#   curl -fsSL <URL-to-this-file> | sh
#
# Installs the source into $DSCode_INSTALL_DIR (default ~/.local/share/dscode),
# builds it, and puts a `dscode` launcher into $DSCode_BIN_DIR
# (default ~/.local/bin). ~/.dscode is left untouched for runtime state.
#
# Prerequisites detected/installed here: node >= 22.19 (required), pnpm (via
# corepack), ripgrep (best-effort). Requires git.

set -e

# --- config ----------------------------------------------------------------
REPO_URL="${DSCode_REPO_URL:-https://github.com/thinkany-ai/dscode.git}"
REPO_BRANCH="${DSCode_REPO_BRANCH:-main}"
INSTALL_DIR="${DSCode_INSTALL_DIR:-$HOME/.local/share/dscode}"
BIN_DIR="${DSCode_BIN_DIR:-$HOME/.local/bin}"
NODE_MIN="22.19.0"

# --- helpers ---------------------------------------------------------------
info() { printf '\033[1;34m[dscode]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[dscode]\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m[dscode]\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  if ! need "$1"; then
    die "missing required command '$1'. Install it and rerun."
  fi
}

# compare dotted versions: return 0 if $1 >= $2
ver_ge() {
  [ "$1" = "$2" ] && return 0
  a=$1; b=$2
  while [ -n "$a" ] || [ -n "$b" ]; do
    da=${a%%.*}; [ "$da" = "$a" ] && a=
    db=${b%%.*}; [ "$db" = "$b" ] && b=
    [ "$da" -gt "$db" ] 2>/dev/null && return 0
    [ "$da" -lt "$db" ] 2>/dev/null && return 1
    a=${a#*.}; b=${b#*.}
  done
  return 0
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      die "unsupported OS: $(uname -s)" ;;
  esac
}

# --- platform --------------------------------------------------------------
OS=$(detect_os)
info "platform: $OS"

# --- node ------------------------------------------------------------------
if need node; then
  NODE_VER=$(node -v | sed 's/^v//')
  if ! ver_ge "$NODE_VER" "$NODE_MIN"; then
    die "node $NODE_VER found, but DSCode requires >= $NODE_MIN."
  fi
  info "node $NODE_VER OK"
else
  die "node not found. Install node >= $NODE_MIN (e.g. 'brew install node@24' on macOS), then rerun."
fi

require_cmd git

# --- pnpm (via corepack, bundled with node) --------------------------------
if need pnpm; then
  PNPM="pnpm"
else
  if command -v corepack >/dev/null 2>&1; then
    info "enabling pnpm via corepack"
    corepack enable 2>/dev/null || true
    if command -v pnpm >/dev/null 2>&1; then
      PNPM="pnpm"
    else
      PNPM="corepack pnpm"
    fi
  else
    die "pnpm not found and corepack unavailable. Install pnpm and rerun."
  fi
fi
info "using pnpm: $PNPM"

# --- ripgrep (required at runtime) -----------------------------------------
if ! need rg; then
  if [ "$OS" = "macos" ] && need brew; then
    warn "ripgrep not found — installing via Homebrew"
    brew install ripgrep
  else
    warn "ripgrep not found. DSCode needs it at runtime."
    warn "Install it: macOS 'brew install ripgrep'; Debian/Ubuntu 'sudo apt install ripgrep'; Fedora 'sudo dnf install ripgrep'."
  fi
fi

# --- clone / update --------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  info "updating existing install in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" reset --hard --quiet "origin/$REPO_BRANCH"
else
  info "cloning $REPO_URL ($REPO_BRANCH) into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# --- build ---------------------------------------------------------------
cd "$INSTALL_DIR"
info "installing dependencies"
$PNPM install --frozen-lockfile
info "building"
$PNPM build

# --- launcher --------------------------------------------------------------
LAUNCHER="$INSTALL_DIR/dscode"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec node "$INSTALL_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$LAUNCHER"

mkdir -p "$BIN_DIR"
ln -sf "$LAUNCHER" "$BIN_DIR/dscode"

# --- PATH ------------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on your PATH."
    case "$SHELL" in
      */zsh) echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.zshrc" && warn "added to ~/.zshrc (restart shell or 'source ~/.zshrc')" ;;
      */bash) echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.bashrc" && warn "added to ~/.bashrc (restart shell or 'source ~/.bashrc')" ;;
      *) warn "add '$BIN_DIR' to your PATH manually." ;;
    esac
    ;;
esac

# --- finish ----------------------------------------------------------------
VERSION=$(node -p "require('./package.json').version")
node scripts/install-message.mjs "$VERSION"
