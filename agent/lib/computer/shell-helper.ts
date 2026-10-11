/**
 * `bot_shell.py`: the program a Bot's shell commands run through, so they run as
 * someone who cannot reach the team's browser.
 *
 * The browser, its DevTools ports, its profiles and the team's sign-in jar all
 * belong to the computer's own user, which eve and the console run as. A Bot's
 * `bash`, `read_file` and `write_file` instead go through `sudo` into this
 * program, which drops to the unprivileged `bot` user with a clean environment
 * and no way to regain privileges, and only once the fence is in place:
 *
 * - Files: the computer's state (`/workspace/.computer`: browser profiles, the
 *   sign-in jar, the gateway key), its run folder in /tmp and the computer
 *   user's home are 0700; `bot` is not that user. The work folders are shared
 *   through the `bot-team` group: setgid, group-writable, and `bot` writes with
 *   umask 002, so the computer's user can read, upload and back up its work.
 *   (No default ACLs: Ubuntu's uutils `mkdir` then makes sticky folders.)
 * - The screens: X displays require a cookie that lives in the computer's state
 *   (see the screens' `-auth`), so `bot` cannot type into them.
 * - Network: the browser listens on more than its DevTools port (VNC, the
 *   gateway, and agent-browser's live stream on a random port, which takes
 *   input too), so `bot` may reach this machine only on an allowlist of ports
 *   that never includes the screens' ranges. With iptables (root with
 *   CAP_NET_ADMIN, as on a Vercel Sandbox VM), `bot`'s TCP over loopback to any
 *   other port is rejected by owner, and the internet stays open. Without it (a
 *   Docker container has no CAP_NET_ADMIN), Landlock (Linux 6.7+) limits all of
 *   `bot`'s TCP connections to the allowlist. With neither, the shell refuses
 *   to run. Where the kernel has it (6.12+), Landlock also keeps `bot` off
 *   abstract unix sockets made outside its own commands, in either mode.
 *
 * Installed root-owned in /usr/local/lib/bot-computer by `bot-computer isolate`;
 * only the computer's user may run it, through sudo. Like the other programs
 * it is a plain string for any sandbox backend, free of `${` and backticks.
 */
export const SHELL_HELPER_DIR = "/usr/local/lib/bot-computer";
export const SHELL_HELPER = `${SHELL_HELPER_DIR}/bot_shell.py`;
/** The user a Bot's commands run as, and the group it shares the work folders through. */
export const SHELL_USER = "bot";
export const SHELL_GROUP = "bot-team";
/** Exit status and stderr prefix of a command the helper refused to run. */
export const SHELL_REFUSED_EXIT = 125;
export const SHELL_REFUSED_MARK = "bot-shell: unavailable:";

/**
 * Ports a Bot's shell may connect to on this machine, and anywhere under
 * Landlock, which can only allow: the web, DNS over TCP, ssh and git, and
 * common local development servers. `BOT_SHELL_TCP_PORTS` adds more. The
 * screens' ranges are never allowed.
 */
export const DEFAULT_SHELL_PORTS = [
  22, 53, 80, 443, 8080, 8443, 9418, 3000, 3001, 3002, 3003, 4173, 5000, 5173, 8000, 8888,
] as const;

/** Loopback port ranges that belong to the screens: VNC, X11 and the gateway, and DevTools. */
export const RESERVED_PORTS = [
  [5900, 6099],
  [9222, 9399],
] as const;

export const SHELL_PY = String.raw`"""bot_shell __VERSION__: runs a Bot's shell commands as a user that cannot reach the team's browser.

Runs as root through sudo, called by the computer's own user:
  setup OWNER STATE RUN PORTS   create the user and group, fence them off, report the mode (JSON)
  check                         report the mode (JSON)
  run CMD CWD ENV               run one command as the Bot (arguments base64; ENV is a JSON object)
  read PATH                     print one file, base64, read as the Bot (PATH base64)
  write PATH STAGE              write a staged file to PATH as the Bot (PATH base64)
A refusal exits 125 with a line starting "bot-shell: unavailable:" on stderr.
"""
import base64
import ctypes
import grp
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys

VERSION = "__VERSION__"
HOME = "__HELPER_DIR__"
STATE_FILE = HOME + "/state.json"
USER = "__USER__"
GROUP = "__GROUP__"
BOT_HOME = "/home/" + USER
WORKSPACE = "/workspace"
LAYOUT = ("shared", "bots", "downloads", "sessions")
CHAIN = "BOT_SHELL"
RESERVED = (__RESERVED__)
REFUSED = 125
MARK = "__MARK__"

PR_SET_NO_NEW_PRIVS = 38
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_ACCESS_NET_CONNECT_TCP = 2
LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET = 1
LANDLOCK_RULE_NET_PORT = 2
# The same numbers on every architecture since Linux 5.13.
SYS_CREATE_RULESET, SYS_ADD_RULE, SYS_RESTRICT_SELF = 444, 445, 446

libc = ctypes.CDLL(None, use_errno=True)


class RulesetAttr(ctypes.Structure):
    _fields_ = [("fs", ctypes.c_uint64), ("net", ctypes.c_uint64), ("scoped", ctypes.c_uint64)]


class PortAttr(ctypes.Structure):
    _fields_ = [("access", ctypes.c_uint64), ("port", ctypes.c_uint64)]


def refuse(reason):
    sys.stderr.write(MARK + " " + reason + "\n")
    sys.exit(REFUSED)


def landlock_abi():
    try:
        return libc.syscall(ctypes.c_long(SYS_CREATE_RULESET), None, ctypes.c_size_t(0), ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION))
    except Exception:
        return -1


def landlock(ports):
    """Confines this process and its children. With ports, TCP connects only to those; returns False if it cannot."""
    abi = landlock_abi()
    net = LANDLOCK_ACCESS_NET_CONNECT_TCP if ports is not None and abi >= 4 else 0
    scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET if abi >= 6 else 0
    if ports is not None and net == 0:
        return False
    if net == 0 and scoped == 0:
        return True
    attr = RulesetAttr(0, net, scoped)
    size = 24 if abi >= 6 else 16
    fd = libc.syscall(ctypes.c_long(SYS_CREATE_RULESET), ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0))
    if fd < 0:
        return ports is None
    for port in ports or ():
        rule = PortAttr(LANDLOCK_ACCESS_NET_CONNECT_TCP, port)
        if libc.syscall(ctypes.c_long(SYS_ADD_RULE), ctypes.c_int(fd), ctypes.c_int(LANDLOCK_RULE_NET_PORT), ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
            os.close(fd)
            return False
    done = libc.syscall(ctypes.c_long(SYS_RESTRICT_SELF), ctypes.c_int(fd), ctypes.c_uint32(0)) == 0
    os.close(fd)
    return done or ports is None


# iptables: the Bot's TCP over loopback reaches only the allowed ports; the rest is rejected by owner.

def rule_body(ports):
    body = [["-p", "tcp", "-m", "multiport", "--dports", ",".join(str(port) for port in ports[i:i + 15]), "-j", "RETURN"]
            for i in range(0, len(ports), 15)]
    # Only new connections: replies from the Bot's own servers to their clients pass.
    return body + [["-p", "tcp", "--syn", "-j", "REJECT", "--reject-with", "tcp-reset"]]


def jump(uid):
    return ["OUTPUT", "-o", "lo", "-p", "tcp", "-m", "owner", "--uid-owner", str(uid), "-j", CHAIN]


def ipt(tool, *args):
    try:
        return subprocess.run([tool, "-w", "5"] + list(args), capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def listing(tool):
    try:
        result = subprocess.run([tool, "-w", "5", "-S", CHAIN], capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.decode() if result.returncode == 0 else None


def fence(tool, uid, ports, expected=None):
    """The chain's listing once the rules are in place, rebuilding them if they are not; None when they cannot be."""
    if expected is not None and ipt(tool, "-C", *jump(uid)) and listing(tool) == expected:
        return expected
    ipt(tool, "-N", CHAIN)
    if not ipt(tool, "-F", CHAIN):
        return None
    for body in rule_body(ports):
        if not ipt(tool, "-A", CHAIN, *body):
            return None
    if not (ipt(tool, "-C", *jump(uid)) or ipt(tool, "-I", *jump(uid))):
        return None
    return listing(tool)


def load_state():
    try:
        with open(STATE_FILE) as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) else None


def bot_ids():
    try:
        return pwd.getpwnam(USER), grp.getgrnam(GROUP).gr_gid
    except KeyError:
        return None, None


def ensure_fence(state, account):
    """Checks the fence before every command; rules lost with a restart are put back."""
    if state is None or state.get("version") != VERSION or account is None:
        refuse("the Bot shell is not set up on this computer")
    if state.get("mode") == "iptables":
        ports = [int(port) for port in state.get("ports", [])]
        for tool, expected in state.get("rules", {}).items():
            if fence(tool, account.pw_uid, ports, expected) is None:
                refuse("the firewall that keeps the Bot shell off the browser is missing and cannot be restored (" + tool + ")")
        return None
    if state.get("mode") == "landlock":
        return [int(port) for port in state.get("ports", [])]
    refuse("this computer can keep the Bot shell off the browser with neither iptables nor Landlock")


def drop(account, gid, ports):
    os.setgroups([gid])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    if os.getuid() == 0 or os.geteuid() == 0:
        refuse("could not leave the root account")
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        refuse("could not turn off privilege escalation")
    if not landlock(ports):
        refuse("could not apply the Landlock network fence")
    os.umask(0o002)


def environment(extra):
    env = {
        "HOME": BOT_HOME,
        "USER": USER,
        "LOGNAME": USER,
        "SHELL": "/bin/bash",
        "PATH": BOT_HOME + "/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG": "C.UTF-8",
        "TMPDIR": "/tmp",
    }
    for name, value in (extra or {}).items():
        if isinstance(name, str) and isinstance(value, str) and name and "=" not in name and "\0" not in name + value:
            env[name] = value
    return env


def decode(text):
    return base64.b64decode(text.encode()).decode("utf-8", "surrogateescape")


def as_bot():
    state = load_state()
    account, gid = bot_ids()
    ports = ensure_fence(state, account)
    return account, gid, ports


def cmd_run(argv):
    command, cwd, extra = decode(argv[0]), decode(argv[1]), json.loads(decode(argv[2]) or "{}")
    account, gid, ports = as_bot()
    drop(account, gid, ports)
    for directory in (cwd, WORKSPACE, BOT_HOME):
        try:
            if directory:
                os.chdir(directory)
                break
        except OSError:
            continue
    os.execve("/bin/bash", ["bash", "-c", command], environment(extra))


def cmd_read(argv):
    path = decode(argv[0])
    account, gid, ports = as_bot()
    drop(account, gid, ports)
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except FileNotFoundError:
        sys.exit(44)
    except IsADirectoryError:
        sys.stderr.write(path + " is a directory\n")
        sys.exit(1)
    except PermissionError:
        sys.stderr.write("permission denied: " + path + "\n")
        sys.exit(13)
    sys.stdout.write(base64.b64encode(data).decode())


def cmd_write(argv):
    path, stage = decode(argv[0]), argv[1]
    # Only a file the calling user staged in the computer's run folder, never any file root can read.
    caller = int(os.environ.get("SUDO_UID", "-1"))
    folder, name = os.path.split(stage)
    if not name.startswith("stage-") or os.path.realpath(folder) != folder:
        refuse("bad staging file")
    fd = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != caller or os.stat(folder).st_uid != caller:
        refuse("bad staging file")
    with os.fdopen(fd, "rb") as handle:
        data = handle.read()
    account, gid, ports = as_bot()
    drop(account, gid, ports)
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(data)
    except PermissionError:
        sys.stderr.write("permission denied: " + path + "\n")
        sys.exit(13)


def run(command):
    return subprocess.run(command, capture_output=True, timeout=60).returncode == 0


def secure_dir(path, owner_uid, mode):
    """Sets a directory's mode without following a link swapped in for it."""
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.fstat(fd).st_uid != owner_uid:
            raise RuntimeError(path + " does not belong to the computer's user")
        os.fchmod(fd, mode)
    finally:
        os.close(fd)


def share_dir(path, owner_uid, gid):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != owner_uid:
            raise RuntimeError(path + " does not belong to the computer's user")
        os.fchown(fd, -1, gid)
        os.fchmod(fd, stat.S_IMODE(info.st_mode) | 0o2070)
    finally:
        os.close(fd)


def normalize(owner, gid, roots):
    """Once, as the computer's user: work made before the shell moved to its own user becomes the team's.

    Walks by file descriptor and never follows a link, so nothing a Bot plants can redirect it."""
    pid = os.fork()
    if pid == 0:
        try:
            account = pwd.getpwnam(owner)
            os.initgroups(owner, account.pw_gid)
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
            for root in roots:
                for _, dirs, files, dirfd in os.fwalk(root, follow_symlinks=False):
                    info = os.fstat(dirfd)
                    if info.st_uid == account.pw_uid:
                        os.fchown(dirfd, -1, gid)
                        os.fchmod(dirfd, stat.S_IMODE(info.st_mode) | 0o2070)
                    for name in files:
                        try:
                            fd = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=dirfd)
                        except OSError:
                            continue
                        try:
                            info = os.fstat(fd)
                            if stat.S_ISREG(info.st_mode) and info.st_uid == account.pw_uid:
                                handle = "/proc/self/fd/" + str(fd)
                                os.chown(handle, -1, gid)
                                mode = stat.S_IMODE(info.st_mode)
                                os.chmod(handle, mode | 0o060 | (0o010 if mode & 0o100 else 0))
                        except OSError:
                            pass
                        finally:
                            os.close(fd)
            os._exit(0)
        except BaseException:
            os._exit(1)
    _, status = os.waitpid(pid, 0)
    return status == 0


def cmd_setup(argv):
    owner, state_dir, run_dir, ports_text = argv[0], argv[1], argv[2], argv[3]
    account = pwd.getpwnam(owner)
    if account.pw_uid == 0:
        raise RuntimeError("the computer's user must not be root")
    previous = load_state() or {}

    try:
        grp.getgrnam(GROUP)
    except KeyError:
        if not run(["groupadd", GROUP]):
            raise RuntimeError("could not create the " + GROUP + " group")
    gid = grp.getgrnam(GROUP).gr_gid
    try:
        pwd.getpwnam(USER)
    except KeyError:
        if not run(["useradd", "--create-home", "--home-dir", BOT_HOME, "--gid", GROUP, "--shell", "/bin/bash", "--comment", "Bot shell", USER]):
            raise RuntimeError("could not create the " + USER + " user")
    bot = pwd.getpwnam(USER)
    if bot.pw_uid == 0 or bot.pw_uid == account.pw_uid:
        raise RuntimeError("the " + USER + " user is not a separate unprivileged account")
    # No password, no sudo: the Bot has nothing to escalate with.
    run(["passwd", "--lock", USER])
    for group in grp.getgrall():
        if USER in group.gr_mem and group.gr_name != GROUP:
            run(["gpasswd", "--delete", USER, group.gr_name])
    if owner not in grp.getgrnam(GROUP).gr_mem:
        run(["usermod", "--append", "--groups", GROUP, owner])
    os.makedirs(BOT_HOME, exist_ok=True)
    os.chown(BOT_HOME, bot.pw_uid, gid)
    os.chmod(BOT_HOME, 0o750)

    # The computer's own: its state, its run folder, and its user's home.
    secure_dir(state_dir, account.pw_uid, 0o700)
    os.makedirs(run_dir, exist_ok=True)
    os.chown(run_dir, account.pw_uid, account.pw_gid)
    secure_dir(run_dir, account.pw_uid, 0o700)
    if account.pw_dir not in ("/", WORKSPACE) and not account.pw_dir.startswith(WORKSPACE + "/") and os.path.isdir(account.pw_dir):
        secure_dir(account.pw_dir, account.pw_uid, 0o700)

    # The team's work: group-shared, new files and folders included.
    shared = [os.path.join(WORKSPACE, name) for name in LAYOUT]
    for path in shared:
        os.makedirs(path, exist_ok=True)
        share_dir(path, account.pw_uid, gid)
    normalized = previous.get("normalized") is True or normalize(owner, gid, shared)

    ports = sorted({int(port) for port in ports_text.split(",") if port.strip().isdigit() and 0 < int(port) < 65536}
                   - {port for low, high in RESERVED for port in range(low, high + 1)})
    rules = {}
    for tool in ("iptables", "ip6tables"):
        listed = fence(tool, bot.pw_uid, ports) if shutil.which(tool) is not None else None
        if listed is not None:
            rules[tool] = listed
    if "iptables" in rules:
        mode = "iptables"
    elif landlock_abi() >= 4:
        mode, rules = "landlock", {}
    else:
        mode, rules = "none", {}
    state = {"version": VERSION, "mode": mode, "rules": rules, "ports": ports, "owner": owner, "normalized": normalized}
    with open(STATE_FILE + ".tmp", "w") as handle:
        json.dump(state, handle)
    os.chmod(STATE_FILE + ".tmp", 0o644)
    os.replace(STATE_FILE + ".tmp", STATE_FILE)
    print(json.dumps(dict(state, ok=mode != "none", landlock=landlock_abi(), **({} if mode != "none" else {
        "step": "isolate", "error": "this computer has neither iptables nor Landlock to keep the Bot shell off the browser"}))))
    return 0 if mode != "none" else 1


def cmd_check(argv):
    state = load_state()
    account, _ = bot_ids()
    if state is None or account is None:
        print(json.dumps({"ok": False, "mode": "unset"}))
        return 1
    print(json.dumps({"ok": state.get("mode") in ("iptables", "landlock"), "mode": state.get("mode"), "version": state.get("version")}))
    return 0


def main(argv):
    if os.geteuid() != 0:
        refuse("bot_shell.py must run through sudo")
    commands = {"setup": (cmd_setup, 4), "check": (cmd_check, 0), "run": (cmd_run, 3), "read": (cmd_read, 1), "write": (cmd_write, 2)}
    name = argv[1] if len(argv) > 1 else ""
    if name not in commands or len(argv) - 2 != commands[name][1]:
        refuse("usage: bot_shell.py setup OWNER STATE RUN PORTS | check | run CMD CWD ENV | read PATH | write PATH STAGE")
    if name == "setup":
        try:
            return cmd_setup(argv[2:])
        except Exception as error:  # reported as data, like the computer's other programs
            print(json.dumps({"ok": False, "step": "isolate", "error": str(error)[-500:]}))
            return 1
    return commands[name][0](argv[2:]) or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;
