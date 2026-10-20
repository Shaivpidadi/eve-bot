"use client";

import { RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { api, errorMessage, SignedOutError } from "./api";
import { ModelsSection } from "./models-page";
import { NotificationsSection } from "./notifications-section";
import { Faint, PageBody, PageError, PageFrame, PageLoading, PageNote } from "./usage-page";

/**
 * Settings: everything the console can change, by area, drawn from the
 * registry (`agent/lib/settings/registry.ts`). A saved value wins over the
 * environment's, which stays the default; the page says which applies and
 * when a change takes effect. Models keep their own picker as the first tab.
 */

type Kind =
  | { type: "number"; min?: number; max?: number; integer?: boolean; unit?: string }
  | { type: "switch" }
  | { type: "text"; placeholder?: string; max?: number }
  | { type: "list"; placeholder?: string }
  | { type: "choice"; options: { value: string; label: string }[] }
  | { type: "secret" };

interface Setting {
  readonly env: string;
  readonly area: string;
  readonly label: string;
  readonly help: string;
  readonly scope: "deployment" | "workspace";
  readonly tier: "live" | "next-start" | "rebuild";
  readonly kind: Kind;
  readonly fallback: string;
  readonly value: string | null;
  readonly source: "setting" | "env" | "default";
  readonly isSet: boolean;
  readonly overridesEnv: boolean;
  readonly editable: boolean;
  readonly pending?: boolean;
}

interface Report {
  readonly editable: boolean;
  readonly owner: boolean;
  readonly settings: readonly Setting[];
}

const AREAS = ["Spend", "Team computer", "Browser", "Memory & decisions", "Email", "Background work", "Team", "Data controls", "Updates", "Notifications", "Models"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function SettingsPage({ area, onArea, onClose }: { area: string | null; onArea: (area: string) => void; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/settings");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.settings)) {
        setReport(body as unknown as Report);
        setError(null);
      } else setError(await errorMessage(response, "Could not load settings."));
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (env: string, value: unknown) => {
    setBusy(env);
    try {
      const response = await api("/bot/v1/settings", { method: "PUT", body: JSON.stringify({ changes: { [env]: value } }) });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.settings)) {
        setReport(body as unknown as Report);
        setError(null);
        return true;
      }
      setError(isRecord(body) && typeof body.error === "string" ? body.error : "Could not save.");
      return false;
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not save.");
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const areas = useMemo(() => AREAS.filter((name) => name === "Models" || name === "Notifications" || (report?.settings ?? []).some((setting) => setting.area === name)), [report]);
  const current = area !== null && (areas as readonly string[]).includes(area) ? area : (areas[0] ?? "Models");

  return (
    <PageFrame title="Settings" label="Settings" onBack={onClose}>
      {report === null ? (
        error === null ? <PageLoading /> : <PageError>{error}</PageError>
      ) : (
        <Tabs value={current} onValueChange={(next) => typeof next === "string" && onArea(next)}>
          <div className="sticky top-[52px] z-10 border-b bg-background px-4">
            <TabsList variant="line" className="h-auto w-full justify-start overflow-x-auto">
              {areas.map((name) => (
                <TabsTrigger key={name} value={name} className="flex-none text-[12.5px]">
                  {name}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {areas.map((name) => (
            <TabsContent key={name} value={name}>
              {name === "Models" ? <ModelsSection /> : null}
              {name === "Notifications" ? <NotificationsSection /> : null}
              {name === "Notifications" || (name === "Models" && !report.settings.some((setting) => setting.area === name)) ? null : (
                <PageBody className="max-w-[760px]">
                  {report.owner || name === "Models" ? null : (
                    <PageNote>These are your workspace&apos;s settings. The rest of the deployment&apos;s are set by its owner.</PageNote>
                  )}
                  {report.editable ? null : <PageNote>This deployment sets everything with its environment (BOT_SETTINGS_EDITABLE=off), so settings are shown here, not changed.</PageNote>}
                  {error === null ? null : <p className="m-0 text-xs text-destructive">{error}</p>}
                  <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[14px] border border-input bg-card">
                    {report.settings
                      .filter((setting) => setting.area === name)
                      .map((setting) => (
                        <Field key={setting.env} setting={setting} busy={busy === setting.env} onSave={(value) => save(setting.env, value)} />
                      ))}
                  </div>
                  <Faint>A change applies within about 30 seconds unless it says otherwise. Reset goes back to the environment&apos;s value.</Faint>
                </PageBody>
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </PageFrame>
  );
}

const TIER_NOTE: Readonly<Record<Setting["tier"], string | null>> = {
  live: null,
  "next-start": "Applies from the computer's or browser's next start.",
  rebuild: "Applies with the next deploy (or the next rebuild of a local server).",
};

/** Where the value in force comes from, in a word. */
function Source({ setting }: { setting: Setting }) {
  const text = setting.source === "setting" ? (setting.overridesEnv ? "Changed here, over .env" : "Changed here") : setting.source === "env" ? "From .env" : `Default: ${setting.fallback}`;
  return <span className={cn("text-[11.5px]", setting.source === "setting" ? "text-brand" : "text-faint")}>{text}</span>;
}

function Field({ setting, busy, onSave }: { setting: Setting; busy: boolean; onSave: (value: unknown) => Promise<boolean> }) {
  const disabled = !setting.editable || busy;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-[13px] sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="font-medium">{setting.label}</b>
        {setting.help === "" ? null : <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{setting.help}</span>}
        {setting.pending ? (
          <span className="text-[11.5px] text-warning">Saved; the running agent was built before it. Applies with the next deploy, or the next npm start here.</span>
        ) : TIER_NOTE[setting.tier] === null ? null : (
          <span className="text-[11.5px] text-faint">{TIER_NOTE[setting.tier]}</span>
        )}
        <span className="flex items-center gap-2">
          <Source setting={setting} />
          {setting.source === "setting" && setting.editable ? (
            <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-faint hover:text-foreground" disabled={busy} onClick={() => void onSave(null)}>
              <RotateCcwIcon className="size-3" /> Reset
            </button>
          ) : null}
        </span>
      </div>
      <div className="flex flex-none items-center sm:w-[260px] sm:justify-end">
        <Control setting={setting} disabled={disabled} onSave={onSave} />
      </div>
    </div>
  );
}

function Control({ setting, disabled, onSave }: { setting: Setting; disabled: boolean; onSave: (value: unknown) => Promise<boolean> }): ReactNode {
  const kind = setting.kind;
  if (kind.type === "switch") {
    const on = /^(1|true|on|yes)$/i.test(setting.value ?? "") || (setting.value === null && /^on$/i.test(setting.fallback));
    return <Switch checked={on} disabled={disabled} aria-label={setting.label} onCheckedChange={(next) => void onSave(next)} />;
  }
  if (kind.type === "choice") {
    return (
      <Select items={kind.options} value={setting.value ?? ""} disabled={disabled} onValueChange={(next) => next !== null && void onSave(next)}>
        <SelectTrigger size="sm" className="w-full bg-secondary text-[12.5px] dark:bg-secondary sm:w-[200px]" aria-label={setting.label}>
          <SelectValue placeholder={setting.fallback} />
        </SelectTrigger>
        <SelectContent>
          {kind.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (kind.type === "secret") return <SecretControl setting={setting} disabled={disabled} onSave={onSave} />;
  return <TextControl setting={setting} disabled={disabled} onSave={onSave} />;
}

/** A text or number field that saves on Enter or with its button, once changed. */
function TextControl({ setting, disabled, onSave }: { setting: Setting; disabled: boolean; onSave: (value: unknown) => Promise<boolean> }) {
  const [draft, setDraft] = useState(setting.value ?? "");
  useEffect(() => setDraft(setting.value ?? ""), [setting.value]);
  const kind = setting.kind;
  const dirty = draft.trim() !== (setting.value ?? "");
  const placeholder = kind.type === "text" || kind.type === "list" ? kind.placeholder : undefined;
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) void onSave(draft.trim() === "" ? null : kind.type === "number" ? Number(draft) : draft);
      }}
    >
      <Input
        className="h-8 min-w-0 flex-1 bg-secondary text-[12.5px] dark:bg-secondary"
        value={draft}
        disabled={disabled}
        aria-label={setting.label}
        inputMode={kind.type === "number" ? "decimal" : undefined}
        placeholder={placeholder ?? setting.fallback}
        onChange={(event) => setDraft(event.target.value)}
      />
      {kind.type === "number" && kind.unit ? <span className="flex-none text-[11.5px] text-faint">{kind.unit}</span> : null}
      {dirty ? (
        <Button type="submit" size="sm" disabled={disabled}>
          Save
        </Button>
      ) : null}
    </form>
  );
}

/** A secret: never shown; set, replace, or remove. */
function SecretControl({ setting, disabled, onSave }: { setting: Setting; disabled: boolean; onSave: (value: unknown) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span className="text-[12.5px] text-muted-foreground">{setting.isSet ? (setting.source === "env" ? "Set in .env" : "Set") : "Not set"}</span>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setEditing(true)}>
          {setting.isSet ? "Replace" : "Set"}
        </Button>
        {setting.source === "setting" ? (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void onSave(null)}>
            Remove
          </Button>
        ) : null}
      </span>
    );
  }
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (draft.trim() === "") return;
        if (await onSave(draft.trim())) {
          setDraft("");
          setEditing(false);
        }
      }}
    >
      <Input className="h-8 min-w-0 flex-1 bg-secondary text-[12.5px] dark:bg-secondary" type="password" autoComplete="off" autoFocus value={draft} aria-label={setting.label} placeholder="Stored sealed; never shown again" onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" size="sm" disabled={disabled || draft.trim() === ""}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}
