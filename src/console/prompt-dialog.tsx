"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** A small question for the person: a name to type, or a yes to a consequence. */
export interface Prompt {
  readonly title: string;
  readonly description?: string;
  /** With a label the dialog asks for text; without one it only confirms. */
  readonly label?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly confirm: string;
  readonly danger?: boolean;
  /** Returns an error to show, or null when done. */
  readonly onConfirm: (value: string) => Promise<string | null>;
}

export function PromptDialog({ prompt, onClose }: { prompt: Prompt | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What the dialog shows stays while it closes, so it does not empty mid-fade.
  const [shown, setShown] = useState<Prompt | null>(prompt);

  useEffect(() => {
    if (prompt !== null) {
      setShown(prompt);
      setError(null);
    }
  }, [prompt]);

  return (
    <Dialog open={prompt !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[400px]">
        {shown === null ? null : (
          <form
            key={shown.title + (shown.defaultValue ?? "")}
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const value = String(new FormData(event.currentTarget).get("value") ?? "").trim();
              if (shown.label !== undefined && value === "") return;
              setBusy(true);
              setError(null);
              try {
                const problem = await shown.onConfirm(value);
                if (problem === null) onClose();
                else setError(problem);
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{shown.title}</DialogTitle>
              {shown.description === undefined ? null : <DialogDescription>{shown.description}</DialogDescription>}
            </DialogHeader>
            {shown.label === undefined ? null : (
              <Field>
                <FieldLabel htmlFor="prompt-value">{shown.label}</FieldLabel>
                <Input
                  id="prompt-value"
                  name="value"
                  defaultValue={shown.defaultValue ?? ""}
                  placeholder={shown.placeholder}
                  maxLength={shown.maxLength ?? 120}
                  required
                  autoComplete="off"
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                />
              </Field>
            )}
            {error === null ? null : <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={shown.danger ? "destructive" : "default"}
                className={shown.danger ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
                disabled={busy}
              >
                {busy ? "…" : shown.confirm}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
