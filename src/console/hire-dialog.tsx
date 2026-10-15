"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { api, errorMessage, SignedOutError } from "./api";

/** A new Bot is a name, a job, and a short description of how it should work. */
export function HireDialog({
  open,
  onClose,
  onHired,
}: {
  open: boolean;
  onClose: () => void;
  onHired: (botId: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[420px]">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const field = (name: string) => String(data.get(name) ?? "").trim();
            setBusy(true);
            setError(null);
            try {
              const response = await api("/bot/v1/bots", {
                method: "POST",
                body: JSON.stringify({ name: field("name"), role: field("role"), persona: field("persona") }),
              });
              if (!response.ok) {
                setError(await errorMessage(response, "Could not create the Bot."));
                return;
              }
              const created = (await response.json()) as { bot: { id: string } };
              form.reset();
              onClose();
              await onHired(created.bot.id);
            } catch (caught) {
              if (!(caught instanceof SignedOutError)) setError("Could not create the Bot.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New Bot</DialogTitle>
            <DialogDescription>Give it a name, a job, and a short description of how it should work.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="hire-name">Name</FieldLabel>
              <Input id="hire-name" name="name" maxLength={40} required placeholder="Ava" />
            </Field>
            <Field>
              <FieldLabel htmlFor="hire-role">Job</FieldLabel>
              <Input id="hire-role" name="role" maxLength={120} required placeholder="Handles inbound sales follow-up" />
            </Field>
            <Field>
              <FieldLabel htmlFor="hire-persona">How it should work</FieldLabel>
              <Textarea
                id="hire-persona"
                name="persona"
                rows={5}
                minLength={20}
                maxLength={4000}
                required
                placeholder="Warm and brief. Never promises a discount. Drafts come to me before anything is sent."
              />
            </Field>
            {error === null ? null : <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create Bot
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
