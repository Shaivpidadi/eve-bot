"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ArrowUpIcon, MicIcon, PlusIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { Avatar } from "./avatar";
import { mentionChoices, typedMention, useTeam } from "./mentions";
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
  const recognition = useRef<Dictation | null>(null);
  const Recognition = dictationApi();
  const team = useTeam();
  // Tagging: "@" before the caret opens a list of teammates to pick from.
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [tagClosed, setTagClosed] = useState<number | null>(null);
  // The tag being typed is read from the box itself whenever it matters, so a
  // stale caret can never splice the tag into the wrong place.
  const tagAt = (value: string, at: number) => {
    // Not in the middle of a word: "@At|las" is editing, not tagging.
    if (/^[\p{L}\p{N}_]/u.test(value.slice(at))) return null;
    const found = typedMention(value, at);
    return found === null || tagClosed === found.start ? null : found;
  };
  const typed = tagAt(text, caret);
  const choices = typed === null ? [] : mentionChoices(team, typed.query, member.id);
  const tagging = typed !== null && choices.length > 0;

  const insertTag = (chosen: Member) => {
    const element = area.current;
    const value = element?.value ?? text;
    const at = element?.selectionStart ?? caret;
    const live = tagAt(value, at);
    if (live === null) return;
    const before = value.slice(0, live.start);
    const after = value.slice(at);
    const tag = `@${chosen.name} `;
    setText(`${before}${tag}${after.replace(/^\s+/, "")}`);
    const next = before.length + tag.length;
    setCaret(next);
    setPick(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next, next);
    });
  };

  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  useEffect(() => {
    if (window.innerWidth > 760) area.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => recognition.current?.stop(), []);

  const send = async (value: string) => {
    const message = value.trim();
    if (message === "") return;
    setText("");
    setCaret(0);
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

  const picked = Math.min(pick, choices.length - 1);

  return (
    <div className="flex-none px-4 pt-2 pb-3.5 max-[760px]:px-2.5 max-[760px]:pb-[calc(10px+env(safe-area-inset-bottom))]">
      <form
        className="composer relative mx-auto flex max-w-[760px] items-end gap-1 rounded-[26px] border border-border bg-card p-[7px] shadow-[0_6px_24px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.04)] transition-[box-shadow,border-color] duration-200 focus-within:border-input focus-within:shadow-[0_8px_30px_rgba(0,0,0,0.1),0_1px_2px_rgba(0,0,0,0.05)]"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        {tagging ? (
          // Anchored to the box and driven from the text box's keys, so it never takes focus.
          <div
            className="mention-menu absolute bottom-[calc(100%+8px)] left-2 z-20 w-[min(320px,calc(100%-16px))] rounded-xl bg-popover p-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            role="listbox"
            aria-label="Tag a teammate"
          >
            <h4 className="mx-2 mt-1 mb-1.5 text-[11.5px] font-medium text-faint">Tag a teammate</h4>
            {choices.map((choice, index) => (
              <button
                key={choice.id}
                type="button"
                role="option"
                aria-selected={index === picked}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
                  index === picked && "bg-accent text-accent-foreground",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onPointerEnter={() => setPick(index)}
                onClick={() => insertTag(choice)}
              >
                <Avatar member={choice} size={20} />
                <span className="flex-none text-[13px] font-semibold">{choice.name}</span>
                <span className="min-w-0 truncate text-xs text-faint">{choice.title}</span>
              </button>
            ))}
          </div>
        ) : null}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger
            render={<Button type="button" variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Suggestions" />}
          >
            <PlusIcon />
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={10} className="w-[300px] gap-0 p-1.5">
            <h4 className="mx-2 mt-1 mb-1.5 text-[11.5px] font-medium text-faint">Suggestions</h4>
            {suggestionsFor(member).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="block w-full rounded-lg px-2 py-[7px] text-left text-[12.5px] outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => void send(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <Textarea
          ref={area}
          rows={1}
          value={text}
          className="max-h-[180px] min-h-0 min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent p-1 text-[13px] leading-5 shadow-none placeholder:text-faint focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
          placeholder={`Message ${member.name} · @ to tag a teammate`}
          onChange={(event) => {
            setText(event.target.value);
            // A thread's first message is on its way: have its session ready by the time it is sent.
            if (event.target.value.trim() !== "") store.prewarm();
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setPick(0);
            setTagClosed(null);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={(event) => {
            const liveTag = tagAt(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
            if (tagging && liveTag !== null) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setPick((current) => (current + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
                event.preventDefault();
                const chosen = choices[picked];
                if (chosen !== undefined) insertTag(chosen);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTagClosed(liveTag.start);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(text);
            }
          }}
        />
        {hasText ? (
          // Your side of the thread wears the colour of the one you are talking to.
          <Button
            type="submit"
            size="icon-sm"
            className="rounded-full bg-(--you) text-white transition-transform hover:bg-(--you) hover:brightness-90 active:scale-92"
            aria-label="Send"
          >
            <ArrowUpIcon />
          </Button>
        ) : live ? (
          <Button type="button" variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Stop" title="Stop" onClick={() => void store.cancel()}>
            <SquareIcon className="fill-current" />
          </Button>
        ) : Recognition !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn("rounded-full text-muted-foreground", listening && "text-destructive hover:text-destructive")}
            aria-label="Dictate"
            onClick={dictate}
          >
            <MicIcon />
          </Button>
        ) : null}
      </form>
    </div>
  );
}
