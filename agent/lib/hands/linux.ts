import {
  activateTab,
  archivePaths,
  restorePaths,
  captureScreen,
  closeTab,
  endRunSession,
  computerStatus,
  ensureRuntime,
  ensureScreen,
  exportIdentity,
  installSoftware,
  listDirectory,
  openUrl,
  raiseBrowser,
  readWorkspaceFile,
  recoverComputer,
  removeWorkspacePath,
  saveTabs,
  sendInput,
  stopScreen,
  syncIdentity,
  writeWorkspaceFile,
  type ComputerIo,
} from "../computer/runtime";
import type { Hands } from "./types";

/**
 * The Linux computer: an X display per screen, Google Chrome over DevTools,
 * websockify for the live view, and a shell fenced off from the browser
 * (iptables, nftables or Landlock). It runs on Vercel Sandbox, Docker, or a
 * microsandbox VM; `computer/runtime.ts` and `computer/script.ts` are its
 * implementation, and nothing outside `hands/` should need them.
 */
export function linuxHands(io: ComputerIo): Hands {
  return {
    kind: "linux",
    shell: {
      run: (command, options) => io.run(command, options),
    },
    files: {
      list: (path) => listDirectory(io, path),
      read: (path) => readWorkspaceFile(io, path),
      write: (path, bytes) => writeWorkspaceFile(io, path, bytes),
      remove: (path) => removeWorkspacePath(io, path),
      archive: (paths) => archivePaths(io, paths),
      restore: (paths, archive) => restorePaths(io, paths, archive),
    },
    screen: {
      ensure: (n, options) => ensureScreen(io, n, options),
      stop: (n) => stopScreen(io, n),
      capture: (n, quality, targetId) => captureScreen(io, n, quality, targetId),
      input: (n, event) => sendInput(io, n, event),
      status: () => computerStatus(io),
    },
    browser: {
      raise: (n) => raiseBrowser(io, n),
      activate: (n, targetId) => activateTab(io, n, targetId),
      close: (n, targetId) => closeTab(io, n, targetId),
      endRun: (session) => endRunSession(io, session),
      open: (n, url, options) => openUrl(io, n, url, options),
      saveTabs: (n) => saveTabs(io, n),
    },
    identity: {
      sync: (n) => syncIdentity(io, n),
      export: (n) => exportIdentity(io, n),
    },
    setup: {
      install: () => installSoftware(io),
      ensure: () => ensureRuntime(io),
      recover: () => recoverComputer(io),
    },
  };
}
