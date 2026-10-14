"use client";

import { ActivityIcon, EyeIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";

import type { TracingSettings } from "../../agent/lib/tracing-settings";
import { api, SignedOutError } from "./api";
import { Faint, PageBody, PageError, PageFrame, PageLoading, PageNote, PageSection } from "./usage-page";

interface TracingState {
  readonly settings: TracingSettings;
  /** Where this server runs: development, preview or production. */
  readonly environment: string;
}

/**
 * Settings for the whole deployment. For now that is tracing: whether every
 * run goes to Vercel Agent Runs, and whether its traces carry the content.
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<TracingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await api("/bot/v1/settings/tracing");
        if (!response.ok) throw new Error("Could not read the settings.");
        const body = (await response.json()) as TracingState;
        if (live) setState(body);
      } catch (caught) {
        if (live && !(caught instanceof SignedOutError)) setError(caught instanceof Error ? caught.message : "Could not read the settings.");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const change = async (patch: Partial<Pick<TracingSettings, "agentRuns" | "content">>) => {
    if (state === null) return;
    const before = state;
    setState({ ...state, settings: { ...state.settings, ...patch } });
    setSaving(true);
    try {
      const response = await api("/bot/v1/settings/tracing", { method: "PATCH", body: JSON.stringify(patch) });
      if (!response.ok) throw new Error("The server did not save that.");
      setState((await response.json()) as TracingState);
      setError(null);
    } catch (caught) {
      setState(before);
      if (!(caught instanceof SignedOutError)) setError(caught instanceof Error ? caught.message : "The server did not save that.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageFrame title="Settings" label="Settings" onBack={onClose}>
      {error !== null ? <PageError>{error}</PageError> : null}
      {state === null ? (
        error === null ? <PageLoading /> : null
      ) : (
        <PageBody>
          <PageSection title="Observability">
            <PageNote>
              Vercel Agent Runs shows every HQ, Bot and job session as a trace in your project&apos;s Observability tab: each model step and tool call,
              with its timing, tokens and errors. These apply to the whole deployment.
            </PageNote>
            <Setting
              icon={<ActivityIcon />}
              title="Send runs to Agent Runs"
              description="From preview and production deployments. Vercel keeps traces for 30 days."
              checked={state.settings.agentRuns}
              disabled={saving}
              onChange={(agentRuns) => void change({ agentRuns })}
            />
            <Setting
              icon={<EyeIcon />}
              title="Include conversation content"
              description="Adds prompts, tool arguments and results to the traces, such as an email a Bot read or a page it opened. Off keeps the timings, models, tokens and errors only."
              checked={state.settings.content}
              disabled={saving || !state.settings.agentRuns}
              onChange={(content) => void change({ content })}
            />
            <Faint>
              {state.environment === "development"
                ? "This server runs locally, so its runs stay in eve dev's own trace view; Agent Runs receives them from a Vercel deployment."
                : "On Vercel, the project also needs a tracing rule: Settings → Tracing, at 100%. Turning content on applies to sessions that start afterwards."}
              {state.settings.updatedBy === null || state.settings.updatedAt === null
                ? ""
                : ` Last changed by ${state.settings.updatedBy} on ${new Date(state.settings.updatedAt).toLocaleDateString()}.`}
            </Faint>
          </PageSection>
        </PageBody>
      )}
    </PageFrame>
  );
}

function Setting({
  icon,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Item variant="outline" className="items-start rounded-xl bg-card">
      <ItemMedia variant="icon" className="text-muted-foreground">
        {icon}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription className="line-clamp-none">{description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch checked={checked} disabled={disabled} aria-label={title} onCheckedChange={(next) => onChange(next)} />
      </ItemActions>
    </Item>
  );
}
