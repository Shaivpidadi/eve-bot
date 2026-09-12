/** The one part of noVNC's client this needs. */
interface KeySender {
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

/**
 * Mac keyboard shortcuts on the team's computer. Its Chrome runs on Linux, where
 * copy, paste, select all, find, and the address bar are Ctrl shortcuts, but
 * noVNC sends ⌘ as Alt, so ⌘C and the rest did nothing. While a person is in
 * control, ⌘ combinations reach the computer as the Ctrl combination a Linux
 * browser expects, and ⌘ with the arrows or Backspace moves and deletes the way
 * it does on a Mac.
 *
 * Shortcuts the viewer's own browser keeps for itself, such as ⌘T, ⌘W, ⌘N, and
 * ⌘Q, never reach the page, so they cannot be forwarded.
 */

const XK = {
  BackSpace: 0xff08,
  Return: 0xff0d,
  Home: 0xff50,
  End: 0xff57,
  Shift_L: 0xffe1,
  Control_L: 0xffe3,
} as const;

interface Chord {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly keysym: number;
  readonly code: string;
}

/** Ctrl+V on the computer, pressed once your clipboard has been handed over. */
export const PASTE: Chord = { ctrl: true, shift: false, keysym: 0x76, code: "KeyV" };

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** What a ⌘ combination means on the computer, or null to leave the key to noVNC. */
function translate(event: KeyboardEvent): readonly Chord[] | null {
  const shift = event.shiftKey;
  switch (event.key) {
    case "ArrowLeft":
      return [{ ctrl: false, shift, keysym: XK.Home, code: "Home" }];
    case "ArrowRight":
      return [{ ctrl: false, shift, keysym: XK.End, code: "End" }];
    case "ArrowUp":
      return [{ ctrl: true, shift, keysym: XK.Home, code: "Home" }];
    case "ArrowDown":
      return [{ ctrl: true, shift, keysym: XK.End, code: "End" }];
    case "Backspace":
      // Delete back to the start of the line.
      return [
        { ctrl: false, shift: true, keysym: XK.Home, code: "Home" },
        { ctrl: false, shift: false, keysym: XK.BackSpace, code: "Backspace" },
      ];
    case "Enter":
      return [{ ctrl: true, shift, keysym: XK.Return, code: "Enter" }];
  }
  if (event.key.length !== 1) return null;
  // Latin-1 characters are their own X keysyms; Shift travels as a held modifier.
  const point = event.key.toLowerCase().codePointAt(0) ?? 0;
  if (point < 0x20 || point > 0xff) return null;
  return [{ ctrl: true, shift, keysym: point, code: event.code }];
}

export function sendChord(client: KeySender, chord: Chord): void {
  if (chord.ctrl) client.sendKey(XK.Control_L, "ControlLeft", true);
  if (chord.shift) client.sendKey(XK.Shift_L, "ShiftLeft", true);
  client.sendKey(chord.keysym, chord.code, true);
  client.sendKey(chord.keysym, chord.code, false);
  if (chord.shift) client.sendKey(XK.Shift_L, "ShiftLeft", false);
  if (chord.ctrl) client.sendKey(XK.Control_L, "ControlLeft", false);
}

/**
 * Translates ⌘ shortcuts for the viewer in `target`, listening ahead of noVNC's
 * own listener on its canvas. Does nothing off a Mac, where Ctrl already works.
 * Returns the function that stops listening.
 */
export function forwardMacShortcuts(target: HTMLElement, client: KeySender, inControl: () => boolean): () => void {
  if (!isMac()) return () => undefined;

  const onKeyDown = (event: KeyboardEvent) => {
    if (!inControl()) return;
    // noVNC would hold Alt down on the computer for ⌘ itself, spoiling the shortcut.
    if (event.key === "Meta") {
      event.stopPropagation();
      return;
    }
    if (!event.metaKey || event.ctrlKey || event.altKey) return;
    const chords = translate(event);
    if (chords === null) return;
    event.stopPropagation();
    // ⌘V: let the browser fire its paste event, which hands your clipboard over and presses Ctrl+V.
    if (event.code === "KeyV" && !event.shiftKey) return;
    event.preventDefault();
    for (const chord of chords) sendChord(client, chord);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (inControl() && (event.key === "Meta" || event.metaKey)) event.stopPropagation();
  };

  const capture = { capture: true } as const;
  target.addEventListener("keydown", onKeyDown, capture);
  target.addEventListener("keyup", onKeyUp, capture);
  return () => {
    target.removeEventListener("keydown", onKeyDown, capture);
    target.removeEventListener("keyup", onKeyUp, capture);
  };
}
