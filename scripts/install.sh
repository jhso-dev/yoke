#!/usr/bin/env bash
# ============================================================================
# yoke installer
# ============================================================================
# Knowledge your AI can trust.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jhso-dev/yoke/main/scripts/install.sh | bash
#
# Options (pass after `bash -s --`):
#   --skip-link   Build but don't `npm link` the global `yoke` command
#   --dir PATH    Install into PATH (default: ~/.yoke/app, or $YOKE_INSTALL_DIR)
# ============================================================================

set -e

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# Configuration
REPO_URL="https://github.com/jhso-dev/yoke"
INSTALL_DIR="${YOKE_INSTALL_DIR:-$HOME/.yoke/app}"
SKIP_LINK=false
CURRENT_STEP="starting"

# curl | bash leaves stdin non-interactive; record it (we never prompt, but the
# link fallback prints manual steps rather than assuming a terminal is present).
if [ -t 0 ]; then
    INTERACTIVE=true
else
    INTERACTIVE=false
fi

# ----------------------------------------------------------------------------
# Log helpers
# ----------------------------------------------------------------------------
log_info()    { printf "${CYAN}→${NC} %s\n" "$1"; }
log_success() { printf "${GREEN}✓${NC} %s\n" "$1"; }
log_warn()    { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
log_error()   { printf "${RED}✗${NC} %s\n" "$1"; }

die() { trap - ERR; log_error "$1"; exit 1; }

on_error() {
    log_error "installation failed during: ${CURRENT_STEP}"
    exit 1
}
trap on_error ERR

print_banner() {
    local w=46
    local bar
    bar=$(printf '─%.0s' $(seq 1 "$w"))
    printf "\n${CYAN}${BOLD}┌%s┐${NC}\n" "$bar"
    printf "${CYAN}${BOLD}│%-*s│${NC}\n" "$w" "  yoke installer"
    printf "${CYAN}${BOLD}│%-*s│${NC}\n" "$w" "  knowledge your AI can trust"
    printf "${CYAN}${BOLD}└%s┘${NC}\n\n" "$bar"
}

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-link)
            SKIP_LINK=true
            shift
            ;;
        --dir)
            INSTALL_DIR="$2"
            shift 2
            ;;
        -h|--help)
            echo "yoke installer"
            echo ""
            echo "Usage: install.sh [--skip-link] [--dir PATH]"
            echo ""
            echo "  --skip-link   Build but don't 'npm link' the global 'yoke' command"
            echo "  --dir PATH    Install directory (default: ~/.yoke/app, or \$YOKE_INSTALL_DIR)"
            exit 0
            ;;
        *)
            die "unknown option: $1"
            ;;
    esac
done

# ----------------------------------------------------------------------------
# Prerequisite checks
# ----------------------------------------------------------------------------
check_git() {
    CURRENT_STEP="checking git"
    if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
        log_success "git $(git --version | awk '{print $3}')"
        return 0
    fi
    die "git not found — install git and re-run (macOS: xcode-select --install · Debian/Ubuntu: sudo apt install git)"
}

check_node() {
    CURRENT_STEP="checking Node.js"
    if ! command -v node >/dev/null 2>&1; then
        die "Node.js not found — install Node >= 20 from https://nodejs.org and re-run"
    fi
    local major
    major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -lt 20 ]; then
        log_error "Node.js $(node --version) is too old — yoke needs Node >= 20"
        die "upgrade Node from https://nodejs.org or via your version manager, then re-run"
    fi
    log_success "Node.js $(node --version)"
}

# ----------------------------------------------------------------------------
# Install steps
# ----------------------------------------------------------------------------
install_repo() {
    if [ -d "$INSTALL_DIR/.git" ]; then
        CURRENT_STEP="updating yoke"
        log_info "existing install at $INSTALL_DIR — updating"
        git -C "$INSTALL_DIR" pull --ff-only
        log_success "updated"
    else
        CURRENT_STEP="downloading yoke"
        log_info "cloning $REPO_URL -> $INSTALL_DIR"
        mkdir -p "$(dirname "$INSTALL_DIR")"
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        log_success "cloned"
    fi
}

build_yoke() {
    # devDependencies (typescript) are needed to build — do NOT use --omit=dev.
    CURRENT_STEP="installing dependencies"
    log_info "installing dependencies (npm ci)"
    ( cd "$INSTALL_DIR" && npm ci )
    log_success "dependencies installed"

    CURRENT_STEP="building"
    log_info "building (npm run build)"
    ( cd "$INSTALL_DIR" && npm run build )
    log_success "build complete"
}

link_yoke() {
    if [ "$SKIP_LINK" = true ]; then
        log_info "skipping global link (--skip-link)"
        return 0
    fi
    CURRENT_STEP="linking the yoke command"
    log_info "linking the yoke command (npm link)"
    if ( cd "$INSTALL_DIR" && npm link ) >/dev/null 2>&1; then
        log_success "yoke command available on your PATH"
    else
        log_warn "npm link failed (a global prefix without sudo is the usual cause)"
        log_info "put yoke on your PATH manually:"
        log_info "  mkdir -p ~/.local/bin"
        log_info "  ln -sf $INSTALL_DIR/dist/front/cli/index.js ~/.local/bin/yoke"
        log_info "  chmod +x $INSTALL_DIR/dist/front/cli/index.js   # then ensure ~/.local/bin is on PATH"
    fi
}

print_next_steps() {
    printf "\n${CYAN}${BOLD}next steps${NC}\n"
    log_info "yoke init      create ./yoke.db and seed the ontology"
    log_info "yoke --help    list every command"
    printf "\n  attach yoke to your AI tool — add to .mcp.json:\n"
    printf "${CYAN}    { \"mcpServers\": {${NC}\n"
    printf "${CYAN}        \"yoke\": { \"command\": \"yoke\", \"args\": [\"mcp\"] } } }${NC}\n\n"
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
main() {
    print_banner
    check_git
    check_node
    install_repo
    build_yoke
    link_yoke
    print_next_steps
    log_success "yoke is ready"
}

main
