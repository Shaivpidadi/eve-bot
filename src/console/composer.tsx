"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "./icons";
import type { RoomStore } from "./room-store";
import { suggestionsFor } from "./suggestions";
import type { Member } from "./types";

/** The slice of the Web Speech API dictation uses; not every browser has it. */
interface Dictation {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type DictationConstructor = new () => Dictation;

function dictationApi(): DictationConstructor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: DictationConstructor;
    webkitSpeechRecognition?: DictationConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

const MAX_HEIGHT_PX = 180;

export function Composer({ member, live, store }: { member: Member; live: boolean; store: RoomStore }) {
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const recognition = useRef<Dictation | null>(null);
  const Recognition = dictationApi();

  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  useEffect(() => {
    if (window.innerWidth > 760) area.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  useEffect(() => () => recognition.current?.stop(), []);

  const send = async (value: string) => {
    const message = value.trim();
    if (message === "") return;
    setText("");
    setMenuOpen(false);
    if (!(await store.send(message))) setText(message);
  };

  const dictate = () => {
    if (recognition.current !== null) {
      recognition.current.stop();
      return;
    }
    if (Recognition === undefined) return;
    const session = new Recognition();
    const before = text;
    session.lang = navigator.language;
    session.interimResults = true;
    session.onresult = (event) => {
      const spoken = Array.from(event.results, (result) => result[0]?.transcript ?? "").join("");
      setText(`${before}${before === "" ? "" : " "}${spoken}`);
    };
    session.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = session;
    setListening(true);
    session.start();
  };

  const hasText = text.trim() !== "";

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <div className="composer-pop" ref={menu}>
          {menuOpen ? (
            <div className="popover">
              <h4>Suggestions</h4>
              {suggestionsFor(member).map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => void send(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            aria-label="Suggestions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="plus" />
          </button>
        </div>
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={`Message ${member.name}`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(text);
            }
          }}
        />
        {hasText ? (
          <button type="submit" className="icon-btn send-btn" aria-label="Send">
            <Icon name="up" />
          </button>
        ) : live ? (
          <button type="button" className="icon-btn" aria-label="Stop" title="Stop" onClick={() => void store.cancel()}>
            <Icon name="stop" />
          </button>
        ) : Recognition !== undefined ? (
          <button
            type="button"
            className={listening ? "icon-btn mic-btn listening" : "icon-btn mic-btn"}
            aria-label="Dictate"
            onClick={dictate}
          >
            <Icon name="mic" />
          </button>
        ) : null}
      </form>
    </div>
  );
}
