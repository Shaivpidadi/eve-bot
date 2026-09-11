import { createHash } from "node:crypto";

/**
 * The software that turns the team's computer into Grok Bot's "Agent Computer":
 * a screen per Bot that people can watch and take over, with a browser, a file
 * manager, and a terminal on it.
 *
 * Small programs and settings are written onto the computer; the programs are
 * idempotent and report one JSON line on stdout:
 *
 * - `bot-computer` (bash): installs the software, starts and stops screens (a
 *   TigerVNC display with a window manager, a dock, and Google Chrome with
 *   DevTools on localhost), and the one public gateway (websockify on 6080).
 * - `bot_computer.py`: the gateway's token check, and relayed mouse and
 *   keyboard input.
 * - The desktop: openbox and tint2 settings, dock icons, and launchers.
 * - `bot-computer-cdp.mjs`: screenshots and the shared sign-in jar over the
 *   Chrome DevTools Protocol.
 *
 * Everything except the gateway listens on 127.0.0.1. The gateway admits a
 * connection only with a fresh, single-use token signed by the app (see
 * `tokens.ts`), because exposed sandbox ports are public URLs.
 *
 * Nothing here may import from the app: the sources are plain strings so any
 * sandbox backend can receive them, and they avoid `${` and backticks so they
 * can live in raw template literals unescaped.
 */

/** Bump when the programs change in a way a running computer must pick up. */
const RUNTIME_REVISION = "1";

/**
 * Bump when the installed packages change, so sandbox templates are rebuilt
 * with them preinstalled. Programs alone are rewritten on the next use.
 */
export const COMPUTER_SOFTWARE_REVISION = "2";

export const COMPUTER_HOME = "/workspace/.computer";
export const COMPUTER_BIN = `${COMPUTER_HOME}/bin`;
export const COMPUTER_SCRIPT = `${COMPUTER_BIN}/bot-computer`;
export const COMPUTER_KEY_PATH = `${COMPUTER_HOME}/key`;
export const COMPUTER_VERSION_PATH = `${COMPUTER_BIN}/.version`;
/** The screen's desktop: window manager and dock settings, icons, and launchers. */
export const COMPUTER_DESKTOP = `${COMPUTER_HOME}/desktop`;
export const GATEWAY_PORT = 6080;
export const SCREEN_SIZE = { width: 1280, height: 800 } as const;

export interface ComputerFile {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

export interface ComputerRuntime {
  /** Changes whenever any program or setting baked into them changes. */
  readonly version: string;
  readonly files: readonly ComputerFile[];
}

/** Used only when the sandbox cannot reach Ubuntu's own archive. */
export const DEFAULT_APT_MIRROR = "https://mirrors.edge.kernel.org/ubuntu";

export function computerRuntime(options: { chromeFlags?: string; aptMirror?: string } = {}): ComputerRuntime {
  const chromeFlags = (options.chromeFlags ?? "").replace(/[^\w\s=,.:/@%+-]/g, "").trim();
  const mirror = options.aptMirror?.trim().replace(/\/+$/, "") ?? "";
  const settings: Record<string, string> = {
    __HOME__: COMPUTER_HOME,
    __PORT__: String(GATEWAY_PORT),
    __WIDTH__: String(SCREEN_SIZE.width),
    __HEIGHT__: String(SCREEN_SIZE.height),
    __EXTRA_CHROME_FLAGS__: chromeFlags,
    __APT_MIRROR__: /^https?:\/\/[\w.-]+(\/[\w./-]*)?$/.test(mirror) ? mirror : DEFAULT_APT_MIRROR,
    __DESKTOP__: COMPUTER_DESKTOP,
    __SCRIPT__: COMPUTER_SCRIPT,
  };
  const fill = (source: string) =>
    Object.entries(settings).reduce((text, [name, value]) => text.replaceAll(name, value), source);

  const launcher = (name: string, kind: string, icon: string, windowClass: string) =>
    fill(
      [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${name}`,
        `Exec=__SCRIPT__ launch ${kind}`,
        `Icon=${icon}`,
        `StartupWMClass=${windowClass}`,
        "Terminal=false",
        "",
      ].join("\n"),
    );

  const sources = [
    { path: COMPUTER_SCRIPT, content: fill(BASH), mode: 0o755 },
    { path: `${COMPUTER_BIN}/bot_computer.py`, content: fill(PYTHON), mode: 0o644 },
    { path: `${COMPUTER_BIN}/bot-computer-cdp.mjs`, content: fill(CDP), mode: 0o644 },
    { path: `${COMPUTER_DESKTOP}/openbox.xml`, content: fill(OPENBOX), mode: 0o644 },
    { path: `${COMPUTER_DESKTOP}/tint2rc`, content: fill(TINT2), mode: 0o644 },
    { path: `${COMPUTER_DESKTOP}/icons/files.svg`, content: FILES_ICON, mode: 0o644 },
    { path: `${COMPUTER_DESKTOP}/icons/terminal.svg`, content: TERMINAL_ICON, mode: 0o644 },
    {
      path: `${COMPUTER_DESKTOP}/applications/browser.desktop`,
      content: launcher("Browser", "browser", "google-chrome", "Google-chrome"),
      mode: 0o644,
    },
    {
      path: `${COMPUTER_DESKTOP}/applications/files.desktop`,
      content: launcher("Files", "files", `${COMPUTER_DESKTOP}/icons/files.svg`, "Pcmanfm"),
      mode: 0o644,
    },
    {
      path: `${COMPUTER_DESKTOP}/applications/terminal.desktop`,
      content: launcher("Terminal", "terminal", `${COMPUTER_DESKTOP}/icons/terminal.svg`, "Xfce4-terminal"),
      mode: 0o644,
    },
  ];
  const digest = createHash("sha256");
  for (const source of sources) digest.update(source.path).update("\0").update(source.content).update("\0");
  const version = `${RUNTIME_REVISION}-${digest.digest("hex").slice(0, 12)}`;
  return {
    version,
    files: sources.map((source) => ({ ...source, content: source.content.replaceAll("__VERSION__", version) })),
  };
}

/**
 * The window manager: Chrome maximized and borderless, drawing its own window
 * buttons the way it does on a desktop; other windows get a title bar. No
 * menus, no desktop icons, no virtual desktops.
 */
const OPENBOX = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <resistance><strength>10</strength><screen_edge_strength>20</screen_edge_strength></resistance>
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy><center>yes</center></placement>
  <theme>
    <name>Onyx</name>
    <titleLayout>NLIMC</titleLayout>
    <keepBorder>yes</keepBorder>
    <animateIconify>no</animateIconify>
    <font place="ActiveWindow"><name>Noto Sans</name><size>10</size><weight>Bold</weight></font>
    <font place="InactiveWindow"><name>Noto Sans</name><size>10</size><weight>Normal</weight></font>
  </theme>
  <desktops><number>1</number><firstdesk>1</firstdesk></desktops>
  <keyboard>
    <keybind key="A-F4"><action name="Close"/></keybind>
    <keybind key="A-Tab"><action name="NextWindow"/></keybind>
    <keybind key="A-S-Tab"><action name="PreviousWindow"/></keybind>
  </keyboard>
  <mouse>
    <dragThreshold>3</dragThreshold>
    <doubleClickTime>300</doubleClickTime>
    <!-- No plain-button bindings on "Frame": openbox does not pass those clicks on to the app. -->
    <context name="Client">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Middle" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Right" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
    </context>
    <context name="Titlebar">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
      <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
    </context>
    <context name="Top"><mousebind button="Left" action="Drag"><action name="Resize"><edge>top</edge></action></mousebind></context>
    <context name="Left"><mousebind button="Left" action="Drag"><action name="Resize"><edge>left</edge></action></mousebind></context>
    <context name="Right"><mousebind button="Left" action="Drag"><action name="Resize"><edge>right</edge></action></mousebind></context>
    <context name="Bottom"><mousebind button="Left" action="Drag"><action name="Resize"><edge>bottom</edge></action></mousebind></context>
    <context name="TLCorner"><mousebind button="Left" action="Drag"><action name="Resize"/></mousebind></context>
    <context name="TRCorner"><mousebind button="Left" action="Drag"><action name="Resize"/></mousebind></context>
    <context name="BLCorner"><mousebind button="Left" action="Drag"><action name="Resize"/></mousebind></context>
    <context name="BRCorner"><mousebind button="Left" action="Drag"><action name="Resize"/></mousebind></context>
    <context name="Close">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Click"><action name="Close"/></mousebind>
    </context>
    <context name="Maximize">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Click"><action name="ToggleMaximize"/></mousebind>
    </context>
    <context name="Iconify">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Click"><action name="Iconify"/></mousebind>
    </context>
  </mouse>
  <applications>
    <application class="Google-chrome"><decor>no</decor><maximized>yes</maximized></application>
    <application class="Tint2"><decor>no</decor><focus>no</focus><skip_taskbar>yes</skip_taskbar></application>
  </applications>
</openbox_config>
`;

/** The dock: a compact bar with Browser, Files, and Terminal, reserving its strip of the screen. */
const TINT2 = String.raw`# Bot computer dock
# Background 1: the dock
rounded = 14
border_width = 1
border_sides = TBLR
background_color = #2a2a2e 92
border_color = #ffffff 14
# Background 2: a hovered icon
rounded = 10
border_width = 0
background_color = #ffffff 16
border_color = #000000 0

panel_items = L
panel_size = 100% 70
panel_margin = 0 8
panel_padding = 12 10 12
panel_background_id = 1
panel_position = bottom center horizontal
panel_layer = top
panel_monitor = all
panel_shrink = 1
panel_window_name = dock
wm_menu = 0
panel_dock = 0
strut_policy = follow_size
disable_transparency = 1
mouse_effects = 1
mouse_hover_icon_asb = 100 0 10
mouse_pressed_icon_asb = 100 0 -10

launcher_padding = 2 2 12
launcher_background_id = 0
launcher_icon_background_id = 2
launcher_icon_size = 48
launcher_icon_asb = 100 0 0
startup_notifications = 0
launcher_tooltip = 1
launcher_item_app = __DESKTOP__/applications/browser.desktop
launcher_item_app = __DESKTOP__/applications/files.desktop
launcher_item_app = __DESKTOP__/applications/terminal.desktop

tooltip_show_timeout = 0.3
tooltip_hide_timeout = 0.1
tooltip_padding = 6 4
tooltip_background_id = 1
tooltip_font_color = #f2f2f2 100
`;

const TERMINAL_ICON = String.raw`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect x="8" y="12" width="112" height="104" rx="22" fill="#1f2023"/>
  <rect x="8.5" y="12.5" width="111" height="103" rx="21.5" fill="none" stroke="#ffffff" stroke-opacity="0.18"/>
  <path d="M34 46 L54 62 L34 78" fill="none" stroke="#f2f2f2" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M62 80 H92" stroke="#f2f2f2" stroke-width="8" stroke-linecap="round"/>
</svg>
`;

const FILES_ICON = String.raw`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <path d="M14 34 a12 12 0 0 1 12 -12 h26 l12 12 h38 a12 12 0 0 1 12 12 v50 a12 12 0 0 1 -12 12 h-76 a12 12 0 0 1 -12 -12 z" fill="#3b82f6"/>
  <path d="M14 48 h100 v48 a12 12 0 0 1 -12 12 h-76 a12 12 0 0 1 -12 -12 z" fill="#60a5fa"/>
  <rect x="44" y="64" width="40" height="6" rx="3" fill="#dbeafe"/>
</svg>
`;

const BASH = String.raw`#!/usr/bin/env bash
# bot-computer __VERSION__: the screens of the team's computer.
# Every subcommand is idempotent and prints one JSON line last. Logs live in $RUN.
set -o pipefail

VERSION="__VERSION__"
STATE="__HOME__"
BIN="$STATE/bin"
PROFILES="$STATE/chrome"
IDENTITY="$STATE/identity"
KEY="$STATE/key"
RUN=/tmp/bot-computer
PORT=__PORT__
WIDTH=__WIDTH__
HEIGHT=__HEIGHT__
PACKAGES="tigervnc-standalone-server websockify xdotool x11-utils x11-xserver-utils fonts-noto-core fonts-noto-color-emoji fonts-liberation ca-certificates curl openbox tint2 pcmanfm xfce4-terminal dbus-x11"
DESK="__DESKTOP__"
CHROME_FLAGS="--remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check --password-store=basic --disable-dev-shm-usage --window-position=0,0 --start-maximized --restore-last-session --hide-crash-restore-bubble --noerrdialogs --test-type --disable-features=Translate,MediaRouter __EXTRA_CHROME_FLAGS__"

mkdir -p "$RUN" "$PROFILES" "$IDENTITY" 2>/dev/null
chmod 700 "$IDENTITY" 2>/dev/null

quote() { python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"; }

fail() {
  printf '{"ok":false,"step":"%s","error":%s}\n' "$1" "$(quote "$(printf '%s' "$2" | tail -c 800)")"
  exit 1
}

screen_arg() {
  case "$1" in [1-9]) ;; *) fail args "expected a screen number from 1 to 9" ;; esac
}

# Patterns are anchored so they never match the shell that is running this script.
display_pattern() { printf '^Xvnc :%s( |$)' "$1"; }
browser_pattern() { printf '^[^ ]*chrome[^ ]* .*--remote-debugging-port=%s( |$)' "$((9300 + $1))"; }
GATEWAY_PATTERN='^[^ ]*python3 [^ ]*websockify .*bot_computer\.BotTokens'
# The desktop's programs are started under a per-screen name, so screens never adopt each other's.
bus_pattern() { printf '^dbus-daemon .*--address=unix:path=%s/bus-%s( |$)' "$RUN" "$1"; }
wm_pattern() { printf '^openbox-screen-%s( |$)' "$1"; }
dock_pattern() { printf '^tint2-screen-%s( |$)' "$1"; }

pid_of() { cat "$RUN/$1.pid" 2>/dev/null; }

# running NAME PATTERN: the named process is up. Adopts a matching process whose
# pid file was lost, and ignores a pid file whose process id was reused.
running() {
  local pid
  pid=$(pid_of "$1")
  if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -qE -- "$2"; then
    return 0
  fi
  pid=$(pgrep -o -f -- "$2" 2>/dev/null) || { rm -f "$RUN/$1.pid"; return 1; }
  echo "$pid" >"$RUN/$1.pid"
}

# daemon NAME COMMAND...: starts COMMAND in its own session so it outlives this call.
# The lock descriptors (8, 9) are closed for it, or it would hold our locks for life.
daemon() {
  local name=$1
  shift
  setsid nohup "$@" >"$RUN/$name.log" 2>&1 </dev/null 8>&- 9>&- &
  echo $! >"$RUN/$name.pid"
}

stop_process() {
  running "$1" "$2" || return 0
  local pid i
  pid=$(pid_of "$1")
  kill "$pid" 2>/dev/null
  for ((i = 0; i < 50; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null
  rm -f "$RUN/$1.pid"
}

# wait_for TENTHS COMMAND...: retries COMMAND every 100 ms.
wait_for() {
  local tries=$1 i
  shift
  for ((i = 0; i < tries; i++)); do
    "$@" && return 0
    sleep 0.1
  done
  return 1
}

# listening PORT: something accepts connections on PORT. Reads the kernel's socket
# table directly: images may lack ss.
# now_ms: milliseconds since the epoch. Not date +%s%3N, which some coreutils lack.
now_ms() {
  local micros
  micros=$(printf '%s' "$EPOCHREALTIME" | tr -d '.,')
  echo $((micros / 1000))
}

listening() {
  cat /proc/net/tcp /proc/net/tcp6 2>/dev/null |
    awk -v port="$(printf ':%04X' "$1")" '$4 == "0A" && substr($2, length($2) - 4) == port { found = 1 } END { exit !found }'
}
display_up() { xdpyinfo -display ":$1" >/dev/null 2>&1; }
cdp_up() { curl -fsS -m 1 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1; }

installed() {
  command -v google-chrome >/dev/null && command -v Xvnc >/dev/null && command -v websockify >/dev/null &&
    command -v xdotool >/dev/null && command -v xdpyinfo >/dev/null &&
    command -v openbox >/dev/null && command -v tint2 >/dev/null && command -v pcmanfm >/dev/null &&
    command -v xfce4-terminal >/dev/null && command -v dbus-daemon >/dev/null && command -v xsetroot >/dev/null
}

# Some sandbox networks cannot reach Ubuntu's plain-HTTP archive at all, and apt
# then crawls through timeouts for an hour. Use an HTTPS mirror when that happens.
use_reachable_mirror() {
  local codename file
  codename=$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")
  curl -4 -fs --max-time 6 -o /dev/null "http://archive.ubuntu.com/ubuntu/dists/$codename/Release" && return 0
  for file in /etc/apt/sources.list.d/*.sources /etc/apt/sources.list; do
    [ -f "$file" ] || continue
    sudo -n sed -i -E "s#https?://(archive|security|[a-z]{2}\.archive)\.ubuntu\.com/ubuntu/?#__APT_MIRROR__/#g" "$file"
  done
}

install_software() {
  installed && return 0
  exec 9>"$RUN/install.lock"
  flock -w 900 9 || fail install "another install is still running"
  installed && return 0
  local log="$RUN/install.log"
  # IPv4 and short network timeouts: a stalled mirror connection must fail and
  # retry, not hang the install for good.
  local apt="sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=30 -o Acquire::Retries=3 -y -qq"
  sudo -n true 2>/dev/null || fail install "installing the browser needs sudo on the computer"
  use_reachable_mirror
  $apt update >>"$log" 2>&1 || fail install "apt-get update failed: $(tail -n 5 "$log")"
  $apt install --no-install-recommends $PACKAGES >>"$log" 2>&1 || fail install "could not install packages: $(tail -n 5 "$log")"
  if ! command -v google-chrome >/dev/null; then
    local arch
    arch=$(dpkg --print-architecture)
    curl -fsSL -o "$RUN/chrome.deb" "https://dl.google.com/linux/direct/google-chrome-stable_current_$arch.deb" >>"$log" 2>&1 ||
      fail install "could not download Google Chrome for $arch"
    $apt install --no-install-recommends "$RUN/chrome.deb" >>"$log" 2>&1 || fail install "could not install Google Chrome: $(tail -n 5 "$log")"
    rm -f "$RUN/chrome.deb"
  fi
  mkdir -p "$HOME/.local/share/applications" 2>/dev/null
  installed || fail install "the install finished but something is still missing: $(tail -n 5 "$log")"
}

INSTALLER_PATTERN='^bash [^ ]*bot-computer install-now( |$)'

# wait_installed SECONDS: installs in the background, so no single call outlives
# its connection, and waits up to SECONDS for it to finish.
wait_installed() {
  installed && return 0
  local tenths=$(($1 * 10)) i
  running installer "$INSTALLER_PATTERN" || daemon installer bash "$0" install-now
  for ((i = 0; i < tenths; i++)); do
    running installer "$INSTALLER_PATTERN" || break
    sleep 0.1
  done
  installed && return 0
  running installer "$INSTALLER_PATTERN" &&
    fail installing "the computer is installing its browser for the first time; this takes a few minutes"
  fail install "installing the computer's software failed: $(tail -n 5 "$RUN/installer.log")"
}

ensure_gateway() {
  [ -s "$KEY" ] || fail gateway "the computer's access key is missing"
  running gateway "$GATEWAY_PATTERN" && return 0
  daemon gateway env PYTHONPATH="$BIN" websockify --heartbeat 30 --token-plugin bot_computer.BotTokens --token-source "$KEY" "0.0.0.0:$PORT"
  wait_for 80 listening "$PORT" || fail gateway "the connection gateway did not start: $(tail -n 3 "$RUN/gateway.log")"
}

# ensure_desktop N: the screen's session bus, window manager, and dock.
ensure_desktop() {
  local n=$1 bus="unix:path=$RUN/bus-$1"
  # GTK loads images through bubblewrap, which cannot build its sandbox unprivileged
  # in this VM. The VM's user already has sudo, so this grants nothing new.
  if [ -x /usr/bin/bwrap ] && [ ! -u /usr/bin/bwrap ]; then sudo -n chmod u+s /usr/bin/bwrap 2>/dev/null; fi
  if ! running "bus$n" "$(bus_pattern "$n")"; then
    rm -f "$RUN/bus-$n"
    daemon "bus$n" dbus-daemon --session --nofork --nopidfile --address="$bus"
    wait_for 30 test -S "$RUN/bus-$n"
  fi
  if ! running "wm$n" "$(wm_pattern "$n")"; then
    DISPLAY=":$n" xsetroot -solid '#3a3a3f' 2>/dev/null
    daemon "wm$n" env DISPLAY=":$n" DBUS_SESSION_BUS_ADDRESS="$bus" \
      bash -c 'exec -a "openbox-screen-$0" openbox --config-file "$1"' "$n" "$DESK/openbox.xml"
  fi
  if ! running "dock$n" "$(dock_pattern "$n")"; then
    daemon "dock$n" env DISPLAY=":$n" DBUS_SESSION_BUS_ADDRESS="$bus" \
      bash -c 'exec -a "tint2-screen-$0" tint2 -c "$1"' "$n" "$DESK/tint2rc"
  fi
}

# stop_display_apps N: windows opened from the dock on this screen.
stop_display_apps() {
  local pid
  for pid in $(pgrep -u "$(id -u)" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    # A process can exit while this runs; its environment is then simply gone.
    { tr '\0' '\n' <"/proc/$pid/environ"; } 2>/dev/null | grep -qx "DISPLAY=:$1" && kill "$pid" 2>/dev/null
  done
}

# stop_screen N: everything on one screen. The browser goes first and gently, so
# it writes its session and reopens the same tabs next time.
stop_screen() {
  local n=$1
  if running "browser$n" "$(browser_pattern "$n")"; then
    node "$BIN/bot-computer-cdp.mjs" tabs-save "$((9300 + n))" "$PROFILES/$n-tabs.json" >/dev/null 2>&1
  fi
  stop_process "browser$n" "$(browser_pattern "$n")"
  stop_display_apps "$n"
  stop_process "dock$n" "$(dock_pattern "$n")"
  stop_process "wm$n" "$(wm_pattern "$n")"
  stop_process "bus$n" "$(bus_pattern "$n")"
  stop_process "display$n" "$(display_pattern "$n")"
  rm -f "$RUN/bus-$n" "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
}

cmd_ensure() {
  local n=$1 started changed=false
  screen_arg "$n"
  started=$(now_ms)
  wait_installed 60
  exec 8>"$RUN/screen-$n.lock"
  flock -w 90 8 || fail ensure "screen $n is still starting"
  ensure_gateway
  local vnc=$((5900 + n)) cdp=$((9300 + n)) profile="$PROFILES/$n"
  if ! running "display$n" "$(display_pattern "$n")"; then
    rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
    daemon "display$n" Xvnc ":$n" -geometry "$WIDTH"x"$HEIGHT" -depth 24 -rfbport "$vnc" -localhost -SecurityTypes None -AlwaysShared -desktop "screen $n"
    wait_for 100 display_up "$n" || fail display "screen $n's display did not start: $(tail -n 3 "$RUN/display$n.log")"
    changed=true
  fi
  # The window manager first, so the browser opens maximized above the dock.
  ensure_desktop "$n"
  if ! running "browser$n" "$(browser_pattern "$n")"; then
    mkdir -p "$profile"
    # A computer restored from a snapshot still carries the old browser's lock.
    rm -f "$profile/SingletonLock" "$profile/SingletonSocket" "$profile/SingletonCookie"
    daemon "browser$n" env DISPLAY=":$n" google-chrome $CHROME_FLAGS --user-data-dir="$profile" --remote-debugging-port="$cdp" --window-size="$WIDTH,$HEIGHT"
    wait_for 300 cdp_up "$cdp" || fail browser "screen $n's browser did not start: $(grep -v -e dbus -e Fontconfig "$RUN/browser$n.log" | tail -n 4)"
    # A new browser starts signed in to whatever the team is already signed in to.
    if [ -s "$IDENTITY/cookies.json" ]; then
      node "$BIN/bot-computer-cdp.mjs" cookies-import "$cdp" "$IDENTITY/cookies.json" >>"$RUN/browser$n.log" 2>&1
    fi
    # Chrome reopens its last session. When the computer stopped before Chrome
    # saved it, the browser comes back empty; reopen the tabs noted last.
    node "$BIN/bot-computer-cdp.mjs" tabs-restore "$cdp" "$PROFILES/$n-tabs.json" >>"$RUN/browser$n.log" 2>&1
    changed=true
  fi
  printf '{"ok":true,"screen":%d,"display":":%d","vnc":%d,"cdp":%d,"started":%s,"ms":%d,"version":"%s"}\n' \
    "$n" "$n" "$vnc" "$cdp" "$changed" "$(($(now_ms) - started))" "$VERSION"
}

cmd_stop() {
  local n=$1
  screen_arg "$n"
  stop_screen "$n"
  printf '{"ok":true,"screen":%d,"stopped":true}\n' "$n"
}

cmd_status() {
  local n screens="" sep="" gateway=false software=false
  for n in 1 2 3 4 5 6 7 8 9; do
    local display=false browser=false desktop=false
    running "display$n" "$(display_pattern "$n")" && display=true
    running "browser$n" "$(browser_pattern "$n")" && browser=true
    running "wm$n" "$(wm_pattern "$n")" && running "dock$n" "$(dock_pattern "$n")" && desktop=true
    if [ "$display" = true ] || [ "$browser" = true ]; then
      screens="$screens$sep{\"screen\":$n,\"display\":$display,\"browser\":$browser,\"desktop\":$desktop}"
      sep=,
    fi
  done
  running gateway "$GATEWAY_PATTERN" && gateway=true
  installed && software=true
  printf '{"ok":true,"version":"%s","installed":%s,"gateway":%s,"screens":[%s]}\n' \
    "$VERSION" "$software" "$gateway" "$screens"
}

cmd_shot() {
  local n=$1 path=$2 quality=$3 target=$4
  screen_arg "$n"
  [ -n "$path" ] || fail args "expected an output path"
  [ -n "$quality" ] || quality=60
  running "browser$n" "$(browser_pattern "$n")" || fail shot "screen $n's browser is not running"
  # Every still frame also notes the open tabs, for a restart that loses them.
  node "$BIN/bot-computer-cdp.mjs" tabs-save "$((9300 + n))" "$PROFILES/$n-tabs.json" >/dev/null 2>&1
  # A target id captures one Bot's tab even when another's is on screen; none means the front tab.
  node "$BIN/bot-computer-cdp.mjs" shot "$((9300 + n))" "$path" "$quality" "$target"
}

# activate N TARGET: bring one Bot's tab to the front of the shared window.
cmd_activate() {
  local n=$1 target=$2
  screen_arg "$n"
  [ -n "$target" ] || fail args "expected a tab target id"
  running "browser$n" "$(browser_pattern "$n")" || fail activate "screen $n's browser is not running"
  node "$BIN/bot-computer-cdp.mjs" activate "$((9300 + n))" "$target"
}

# close-tab N TARGET: close one Bot's tab when its job is done.
cmd_close_tab() {
  local n=$1 target=$2
  screen_arg "$n"
  [ -n "$target" ] || fail args "expected a tab target id"
  running "browser$n" "$(browser_pattern "$n")" || { printf '{"ok":true,"closed":false}\n'; return 0; }
  node "$BIN/bot-computer-cdp.mjs" close-target "$((9300 + n))" "$target"
}

# launch KIND: what the dock's icons do. The screen comes from DISPLAY.
cmd_launch() {
  local kind=$1 n bus
  n=$(printf '%s' "$DISPLAY" | tr -dc '0-9')
  screen_arg "$n"
  bus="unix:path=$RUN/bus-$n"
  case "$kind" in
    browser)
      if running "browser$n" "$(browser_pattern "$n")"; then
        # The running Chrome takes this and opens a window; the Bot's DevTools connection stays.
        setsid nohup env DISPLAY=":$n" google-chrome --user-data-dir="$PROFILES/$n" --new-window \
          >/dev/null 2>&1 </dev/null 8>&- 9>&- &
      else
        cmd_ensure "$n" >/dev/null
      fi
      ;;
    files)
      setsid nohup env DISPLAY=":$n" DBUS_SESSION_BUS_ADDRESS="$bus" pcmanfm /workspace \
        >/dev/null 2>&1 </dev/null 8>&- 9>&- &
      ;;
    terminal)
      setsid nohup env DISPLAY=":$n" DBUS_SESSION_BUS_ADDRESS="$bus" xfce4-terminal --working-directory=/workspace \
        >/dev/null 2>&1 </dev/null 8>&- 9>&- &
      ;;
    *) fail args "expected browser, files, or terminal" ;;
  esac
  printf '{"ok":true,"launched":"%s","screen":%d}\n' "$kind" "$n"
}

# reload: running screens pick up new window manager and dock settings.
cmd_reload() {
  local n count=0
  for n in 1 2 3 4 5 6 7 8 9; do
    running "wm$n" "$(wm_pattern "$n")" || continue
    DISPLAY=":$n" openbox --reconfigure >/dev/null 2>&1
    running "dock$n" "$(dock_pattern "$n")" && kill -USR1 "$(pid_of "dock$n")" 2>/dev/null
    count=$((count + 1))
  done
  printf '{"ok":true,"reloaded":%d}\n' "$count"
}

# raise N: brings the browser to the front, for a Bot about to use it.
cmd_raise() {
  local n=$1
  screen_arg "$n"
  local id
  # Only the windows the window manager manages: Chrome also has hidden helper windows.
  for id in $(DISPLAY=":$n" xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -oE '0x[0-9a-f]+'); do
    if DISPLAY=":$n" xprop -id "$id" WM_CLASS 2>/dev/null | grep -q '"Google-chrome"'; then
      DISPLAY=":$n" xdotool windowmap "$id" windowactivate "$id" >/dev/null 2>&1
    fi
  done
  printf '{"ok":true,"screen":%d}\n' "$n"
}

cmd_open() {
  local n=$1 url=$2 when=$3
  screen_arg "$n"
  case "$url" in http://* | https://*) ;; *) fail args "expected an http or https address" ;; esac
  case "$when" in "" | if-blank) ;; *) fail args "expected nothing or if-blank after the address" ;; esac
  running "browser$n" "$(browser_pattern "$n")" || fail open "screen $n's browser is not running"
  node "$BIN/bot-computer-cdp.mjs" open "$((9300 + n))" "$url" "$when"
}

# tabs save N: notes the open tabs now, for instance when a person hands the browser back.
cmd_tabs() {
  local action=$1 n=$2
  [ "$action" = save ] || fail args "expected: tabs save N"
  screen_arg "$n"
  running "browser$n" "$(browser_pattern "$n")" || fail tabs "screen $n's browser is not running"
  node "$BIN/bot-computer-cdp.mjs" tabs-save "$((9300 + n))" "$PROFILES/$n-tabs.json"
}

cmd_input() {
  local n=$1
  screen_arg "$n"
  running "display$n" "$(display_pattern "$n")" || fail input "screen $n is not running"
  python3 "$BIN/bot_computer.py" input ":$n" "$2"
}

cmd_identity() {
  local action=$1 n=$2 other count=0
  screen_arg "$n"
  running "browser$n" "$(browser_pattern "$n")" || fail identity "screen $n's browser is not running"
  case "$action" in
    export) node "$BIN/bot-computer-cdp.mjs" cookies-export "$((9300 + n))" "$IDENTITY/cookies.json" ;;
    import) node "$BIN/bot-computer-cdp.mjs" cookies-import "$((9300 + n))" "$IDENTITY/cookies.json" ;;
    sync)
      node "$BIN/bot-computer-cdp.mjs" cookies-export "$((9300 + n))" "$IDENTITY/cookies.json" >"$RUN/identity.log" 2>&1 ||
        fail identity "could not read screen $n's sign-ins: $(tail -n 2 "$RUN/identity.log")"
      for other in 1 2 3 4 5 6 7 8 9; do
        [ "$other" = "$n" ] && continue
        running "browser$other" "$(browser_pattern "$other")" || continue
        node "$BIN/bot-computer-cdp.mjs" cookies-import "$((9300 + other))" "$IDENTITY/cookies.json" >>"$RUN/identity.log" 2>&1 &&
          count=$((count + 1))
      done
      printf '{"ok":true,"screen":%d,"synced":%d}\n' "$n" "$count"
      ;;
    *) fail args "expected export, import, or sync" ;;
  esac
}

cmd_recover() {
  local n
  for n in 1 2 3 4 5 6 7 8 9; do
    stop_screen "$n"
  done
  stop_process gateway "$GATEWAY_PATTERN"
  rm -f "$RUN"/*.lock
  printf '{"ok":true,"recovered":true}\n'
}

case "$1" in
  version) printf '{"ok":true,"version":"%s"}\n' "$VERSION" ;;
  install)
    wait_installed 100
    printf '{"ok":true,"installed":true}\n'
    ;;
  install-now)
    install_software
    printf '{"ok":true,"installed":true}\n'
    ;;
  ensure) cmd_ensure "$2" ;;
  stop) cmd_stop "$2" ;;
  status) cmd_status ;;
  shot) cmd_shot "$2" "$3" "$4" "$5" ;;
  activate) cmd_activate "$2" "$3" ;;
  close-tab) cmd_close_tab "$2" "$3" ;;
  open) cmd_open "$2" "$3" "$4" ;;
  tabs) cmd_tabs "$2" "$3" ;;
  launch) cmd_launch "$2" ;;
  raise) cmd_raise "$2" ;;
  reload) cmd_reload ;;
  input) cmd_input "$2" "$3" ;;
  identity) cmd_identity "$2" "$3" ;;
  recover) cmd_recover ;;
  *) fail args "usage: bot-computer version | install | ensure N | stop N | status | launch browser|files|terminal | raise N | reload | open N URL [if-blank] | tabs save N | shot N PATH [QUALITY] | input N JSON | identity export|import|sync N | recover" ;;
esac
`;

const PYTHON = String.raw`"""bot_computer __VERSION__: the gateway's token check and relayed input."""
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time

RUN = "/tmp/bot-computer"
NONCES = os.path.join(RUN, "nonces")
NONCE_SHAPE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
TARGET_BASE = {"browser": 5900}
LONGEST_TOKEN_SECONDS = 3600


def _unpad(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify(token, key):
    """The token's claims if the app signed it and it is still fresh, else None."""
    if not isinstance(token, str) or token.count(".") != 1:
        return None
    body, signature = token.split(".")
    expected = base64.urlsafe_b64encode(hmac.new(key, body.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        claims = json.loads(_unpad(body))
    except (ValueError, TypeError):
        return None
    now = time.time()
    if not isinstance(claims, dict):
        return None
    expires = claims.get("exp")
    screen = claims.get("n")
    if not isinstance(expires, (int, float)) or not now <= expires <= now + LONGEST_TOKEN_SECONDS:
        return None
    if not isinstance(screen, int) or not 1 <= screen <= 9 or claims.get("target") not in TARGET_BASE:
        return None
    if not isinstance(claims.get("nonce"), str) or not NONCE_SHAPE.match(claims["nonce"]):
        return None
    return claims


def spend(nonce):
    """True the first time a nonce is seen. Each connection runs in its own process, so this uses the filesystem."""
    os.makedirs(NONCES, mode=0o700, exist_ok=True)
    cutoff = time.time() - LONGEST_TOKEN_SECONDS
    for name in os.listdir(NONCES):
        path = os.path.join(NONCES, name)
        try:
            if os.stat(path).st_mtime < cutoff:
                os.unlink(path)
        except OSError:
            pass
    try:
        os.close(os.open(os.path.join(NONCES, nonce), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        return True
    except FileExistsError:
        return False


try:
    from websockify.token_plugins import BasePlugin
except ImportError:  # imported outside websockify, for the input helper
    BasePlugin = object


class BotTokens(BasePlugin):
    """websockify token plugin: a valid token routes to one screen's display."""

    def __init__(self, src=None):
        self.source = src

    def lookup(self, token):
        try:
            with open(self.source, "rb") as handle:
                key = handle.read().strip()
        except OSError:
            return None
        claims = verify(token, key)
        if claims is None or not spend(claims["nonce"]):
            return None
        return ("127.0.0.1", str(TARGET_BASE[claims["target"]] + claims["n"]))


KEY_NAME = re.compile(r"^[A-Za-z0-9_+]{1,48}$")
BUTTONS = {"left": "1", "middle": "2", "right": "3"}


def send_input(display, payload):
    """Relays one mouse or keyboard event to a screen, for backends without a live connection."""
    event = json.loads(payload)
    kind = event.get("type")

    def coordinate(name, limit):
        return str(max(0, min(limit, int(event.get(name, 0)))))

    x, y = coordinate("x", __WIDTH__ - 1), coordinate("y", __HEIGHT__ - 1)
    if kind == "click":
        clicks = str(max(1, min(3, int(event.get("clicks", 1)))))
        command = ["mousemove", "--sync", x, y, "click", "--repeat", clicks, BUTTONS.get(event.get("button"), "1")]
    elif kind == "move":
        command = ["mousemove", "--sync", x, y]
    elif kind == "scroll":
        steps = max(-20, min(20, int(event.get("dy", 0))))
        command = ["mousemove", "--sync", x, y, "click", "--repeat", str(abs(steps) or 1), "5" if steps > 0 else "4"]
    elif kind == "type":
        command = ["type", "--delay", "8", "--", str(event.get("text", ""))[:4000]]
    elif kind == "key":
        key = str(event.get("key", ""))
        if not KEY_NAME.match(key):
            raise ValueError("unsupported key")
        command = ["key", "--", key]
    else:
        raise ValueError("unsupported input type")
    result = subprocess.run(["xdotool"] + command, env=dict(os.environ, DISPLAY=display), capture_output=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode(errors="replace")[-300:])


def main(argv):
    try:
        if len(argv) == 4 and argv[1] == "input":
            send_input(argv[2], argv[3])
            print(json.dumps({"ok": True}))
        else:
            print(json.dumps({"ok": False, "error": "usage: bot_computer.py input DISPLAY JSON"}))
            return 2
    except Exception as error:  # reported as data, like every other subcommand
        print(json.dumps({"ok": False, "step": argv[1] if len(argv) > 1 else "", "error": str(error)[-500:]}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

const CDP = String.raw`// bot-computer-cdp __VERSION__: screenshots and the shared sign-in jar over the Chrome DevTools Protocol.
import { readFile, rename, writeFile } from "node:fs/promises";

const [command, portText, path, extra, extra2] = process.argv.slice(2);
const port = Number(portText);

const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");

async function devtools(route) {
  const response = await fetch("http://127.0.0.1:" + port + route, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(route + " answered " + response.status);
  return response.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let next = 0;
    const opening = setTimeout(() => reject(new Error("timed out connecting to the browser")), 5000);
    socket.onopen = () => {
      clearTimeout(opening);
      resolve({
        send(method, params = {}) {
          const id = ++next;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((done, failed) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              failed(new Error(method + " timed out"));
            }, 15000);
            pending.set(id, { done, failed, timer });
          });
        },
        close: () => socket.close(),
      });
    };
    socket.onerror = () => {
      clearTimeout(opening);
      reject(new Error("could not connect to the browser"));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.failed(new Error(message.error.message));
      else waiter.done(message.result);
    };
  });
}

async function browserConnection() {
  const version = await devtools("/json/version");
  return connect(version.webSocketDebuggerUrl);
}

async function frontPage() {
  const targets = await devtools("/json/list");
  const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
  if (page === undefined) throw new Error("the browser has no open page");
  return page;
}

/** A specific tab by its CDP target id, so one Bot's tab is captured while another's is on screen. */
async function pageById(id) {
  const targets = await devtools("/json/list");
  const page = targets.find((target) => target.id === id && target.type === "page");
  if (page === undefined) throw new Error("that tab is gone");
  return page;
}

function cookieParam(cookie) {
  const { size, session, partitionKeyOpaque, ...param } = cookie;
  if (session) delete param.expires;
  return param;
}

const commands = {
  async "cookies-export"() {
    const browser = await browserConnection();
    try {
      const { cookies } = await browser.send("Storage.getCookies");
      await writeFile(path + ".tmp", JSON.stringify({ at: new Date().toISOString(), cookies }), { mode: 0o600 });
      await rename(path + ".tmp", path);
      print({ ok: true, cookies: cookies.length });
    } finally {
      browser.close();
    }
  },
  async "cookies-import"() {
    let saved;
    try {
      saved = JSON.parse(await readFile(path, "utf8"));
    } catch {
      print({ ok: true, cookies: 0 });
      return;
    }
    const cookies = (saved.cookies ?? []).map(cookieParam);
    const browser = await browserConnection();
    try {
      let imported = 0;
      try {
        await browser.send("Storage.setCookies", { cookies });
        imported = cookies.length;
      } catch {
        // One malformed cookie fails the whole batch; keep the rest.
        for (const cookie of cookies) {
          try {
            await browser.send("Storage.setCookies", { cookies: [cookie] });
            imported += 1;
          } catch {}
        }
      }
      print({ ok: true, cookies: imported });
    } finally {
      browser.close();
    }
  },
  async shot() {
    const page = extra2 ? await pageById(extra2) : await frontPage();
    const tab = await connect(page.webSocketDebuggerUrl);
    try {
      const quality = Math.min(90, Math.max(20, Number(extra) || 60));
      const { data } = await tab.send("Page.captureScreenshot", { format: "jpeg", quality });
      const bytes = Buffer.from(data, "base64");
      await writeFile(path, bytes);
      print({ ok: true, path, bytes: bytes.length, url: page.url, title: page.title });
    } finally {
      tab.close();
    }
  },
  async page() {
    const page = await frontPage();
    print({ ok: true, url: page.url, title: page.title });
  },
  // The open web pages, so a browser that restarts without them can reopen them.
  async "tabs-save"() {
    const targets = await devtools("/json/list");
    const urls = targets.filter((t) => t.type === "page" && /^https?:/.test(t.url)).map((t) => t.url).slice(0, 12);
    // Nothing worth keeping on screen: leave the last note alone rather than erase it.
    if (urls.length === 0) return print({ ok: true, saved: 0 });
    await writeFile(path + ".tmp", JSON.stringify({ at: new Date().toISOString(), urls }), { mode: 0o600 });
    await rename(path + ".tmp", path);
    print({ ok: true, saved: urls.length });
  },
  async "tabs-restore"() {
    let urls = [];
    try {
      urls = (JSON.parse(await readFile(path, "utf8")).urls ?? []).filter((url) => /^https?:/.test(url));
    } catch {}
    if (urls.length === 0) return print({ ok: true, restored: 0 });
    // Give Chrome's own session restore a moment; if it brings pages back, keep those.
    let pages = [];
    for (let i = 0; i < 8; i++) {
      pages = (await devtools("/json/list")).filter((t) => t.type === "page");
      if (pages.some((t) => /^https?:/.test(t.url))) return print({ ok: true, restored: 0, restoredByBrowser: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const browser = await browserConnection();
    try {
      for (const [index, url] of urls.entries()) {
        if (index === 0 && pages[0] !== undefined) {
          const tab = await connect(pages[0].webSocketDebuggerUrl);
          try {
            await tab.send("Page.navigate", { url });
          } finally {
            tab.close();
          }
        } else {
          await browser.send("Target.createTarget", { url, background: true });
        }
      }
      print({ ok: true, restored: urls.length });
    } finally {
      browser.close();
    }
  },
  async activate() {
    // Bring one tab to the front of the shared window; "path" is its CDP target id.
    const browser = await browserConnection();
    try {
      await browser.send("Target.activateTarget", { targetId: path });
      print({ ok: true, targetId: path });
    } finally {
      browser.close();
    }
  },
  async "close-target"() {
    const browser = await browserConnection();
    try {
      await browser.send("Target.closeTarget", { targetId: path });
      print({ ok: true, targetId: path });
    } finally {
      browser.close();
    }
  },
  async open() {
    const page = await frontPage();
    // "if-blank": only when nothing is on screen yet, so a restored tab is never replaced.
    if (extra === "if-blank" && !/^(chrome:\/\/new-?tab|about:blank|chrome-search:)/.test(page.url)) {
      print({ ok: true, url: page.url, kept: true });
      return;
    }
    const tab = await connect(page.webSocketDebuggerUrl);
    try {
      await tab.send("Page.navigate", { url: path });
      print({ ok: true, url: path });
    } finally {
      tab.close();
    }
  },
};

const run = commands[command];
if (run === undefined || !Number.isInteger(port)) {
  print({ ok: false, error: "usage: bot-computer-cdp.mjs cookies-export|cookies-import|shot|page|open|tabs-save|tabs-restore PORT [PATH] [EXTRA]" });
  process.exit(2);
}
try {
  await run();
  process.exit(0);
} catch (error) {
  print({ ok: false, step: command, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
`;
