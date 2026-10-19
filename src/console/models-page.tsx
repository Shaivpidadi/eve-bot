"use client";

import { EyeIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorSeparator,
} from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { api, errorMessage, SignedOutError } from "./api";
import { BrandMark } from "./brands";
import { Faint, PageBody, PageError, PageFrame, PageLoading, PageNote, PageSection } from "./usage-page";

/**
 * The Models page: which Vercel AI Gateway model each role runs on, picked
 * from Gateway's list (free models first) or named outright, and one switch
 * that puts the whole team on free models. See `agent/lib/model-settings.ts`.
 */

type Role = "hq" | "standard" | "quick" | "deep" | "helper";

interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly free: boolean;
  readonly inputPerM: number | null;
  readonly outputPerM: number | null;
  readonly priceVaries: boolean;
  readonly context: number | null;
  readonly vision: boolean;
  readonly structured: boolean;
}

interface Chosen {
  readonly id: string;
  readonly listed: boolean;
  readonly free: boolean;
}

interface Report {
  readonly editable: boolean;
  readonly endpoint: string | null;
  readonly zdr: boolean;
  readonly freeOnly: boolean;
  readonly freeDefault: Chosen | null;
  readonly at: string | null;
  readonly by: string | null;
  readonly catalog: { readonly models: readonly CatalogModel[]; readonly at: string | null; readonly error: string | null };
  readonly roles: readonly {
    readonly role: Role;
    readonly setting: Chosen | null;
    readonly default: string;
    readonly resolved: { readonly id: string; readonly free: boolean; readonly source: "setting" | "free" | "default" };
    readonly warnings: readonly string[];
  }[];
}

const ROLES: Readonly<Record<Role, { readonly label: string; readonly purpose: string }>> = {
  hq: { label: "HQ", purpose: "The conversation: understands what you ask, plans, and hands work to Bots." },
  standard: { label: "Bots, standard", purpose: "Most jobs: working in web apps, reading, and drafting." },
  quick: { label: "Bots, quick", purpose: "Lookups, status checks, and routine monitors." },
  deep: { label: "Bots, deep", purpose: "Hard research, analysis, and coding." },
  helper: { label: "Helper", purpose: "Small calls: saving memories, a new Bot's hello, and team suggestions." },
};

/** Gateway model ids: provider/model. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,40}\/[a-z0-9][a-z0-9._:-]{0,79}$/i;

const usd = (value: number) => (value === 0 ? "$0" : value < 0.1 ? `$${value.toFixed(3)}` : value < 10 ? `$${value.toFixed(2)}` : `$${Math.round(value)}`);

/** "Free", or what it costs per million tokens in and out. */
function price(model: CatalogModel | undefined): string {
  if (model === undefined) return "price unknown";
  if (model.free) return "Free";
  if (model.inputPerM === null || model.outputPerM === null) return "price varies";
  return `${usd(model.inputPerM)} / ${usd(model.outputPerM)} per M${model.priceVaries ? ", varies" : ""}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function ModelsPage({ onClose }: { onClose: () => void }) {
  return (
    <PageFrame title="Models" label="Models" onBack={onClose}>
      <ModelsSection />
    </PageFrame>
  );
}

/** The Models page's contents, also the Models tab of Settings. */
export function ModelsSection() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<Role | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/models");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.roles)) {
        setReport(body as unknown as Report);
        setError(null);
      } else setError(await errorMessage(response, "Could not load models."));
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load models.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (change: { freeOnly?: boolean; roles?: Partial<Record<Role, string | null>> }) => {
    setBusy(true);
    try {
      const response = await api("/bot/v1/models", { method: "PUT", body: JSON.stringify(change) });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.roles)) {
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
      setBusy(false);
    }
  }, []);

  const byId = useMemo(() => new Map((report?.catalog.models ?? []).map((model) => [model.id, model])), [report]);

  return (
    <>
      {report === null ? (
        error === null ? <PageLoading /> : <PageError>{error}</PageError>
      ) : report.endpoint !== null ? (
        <PageBody className="max-w-[760px]">
          <PageNote>
            Models come from your own endpoint, <code>{report.endpoint}</code>, and are set with environment variables (<code>BOT_MODEL</code>, <code>BOT_HQ_MODEL</code>,{" "}
            <code>BOT_MODEL_QUICK</code> and the like). See docs/configuration.md.
          </PageNote>
          <PageSection title="Roles">
            <List>
              {report.roles.map((row) => (
                <Row key={row.role}>
                  <RowMain title={ROLES[row.role].label}>{ROLES[row.role].purpose}</RowMain>
                  <code className="flex-none font-mono text-xs text-muted-foreground">{row.resolved.id}</code>
                </Row>
              ))}
            </List>
          </PageSection>
        </PageBody>
      ) : (
        <PageBody className="max-w-[760px]">
          <PageNote>
            From Vercel AI Gateway. A change applies from HQ&apos;s next message and each Bot&apos;s next job, within about 30 seconds; a job already running keeps
            its model.
            {report.editable ? null : " This deployment sets its models itself (BOT_MODELS_EDITABLE=off), so they are shown here, not changed."}
          </PageNote>
          {error === null ? null : <p className="m-0 text-xs text-destructive">{error}</p>}
          {report.catalog.error === null ? null : (
            <Faint>
              AI Gateway&apos;s list could not be read ({report.catalog.error}){report.catalog.at === null ? "" : "; showing the last one"}. You can still name a model.
            </Faint>
          )}

          <PageSection title="Cost">
            <List>
              <Row>
                <RowMain title="Free models only">
                  {report.zdr
                    ? "Off: this deployment asks for Zero Data Retention (BOT_ZDR), and no free model offers it."
                    : "Every role runs on a model Vercel serves at no cost. Free models can change or go away and keep no Zero Data Retention promise. Embeddings, decisions and web search still bill."}
                </RowMain>
                <Switch
                  checked={report.freeOnly}
                  disabled={busy || !report.editable || report.zdr}
                  aria-label="Free models only"
                  onCheckedChange={(next) => void save({ freeOnly: next })}
                />
              </Row>
            </List>
            {report.freeOnly && report.freeDefault !== null ? (
              <Faint>
                Roles not set to a free model run on {byId.get(report.freeDefault.id)?.name ?? report.freeDefault.id}, the free model that can see screenshots.
              </Faint>
            ) : null}
          </PageSection>

          <PageSection title="Roles">
            <List>
              {report.roles.map((row) => {
                const model = byId.get(row.resolved.id);
                return (
                  <Row key={row.role} className="items-start">
                    <RowMain title={ROLES[row.role].label}>
                      {ROLES[row.role].purpose}
                      {row.warnings.map((warning) => (
                        <span key={warning} className="mt-1 flex items-start gap-1.5 text-warning">
                          <TriangleAlertIcon className="mt-0.5 size-3.5 flex-none" />
                          {warning}
                        </span>
                      ))}
                    </RowMain>
                    <button
                      type="button"
                      className="flex max-w-[52%] flex-none cursor-pointer items-center gap-2.5 rounded-[10px] border border-input bg-background px-2.5 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:opacity-70"
                      disabled={!report.editable || busy}
                      onClick={() => setPicking(row.role)}
                      aria-label={`Model for ${ROLES[row.role].label}: ${model?.name ?? row.resolved.id}. Change`}
                    >
                      <BrandMark label={row.resolved.id.split("/")[0] ?? row.resolved.id} size={26} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[13px] font-medium">{model?.name ?? row.resolved.id}</span>
                        <span className="truncate text-[11.5px] text-muted-foreground">
                          {row.resolved.source === "default" ? "Default · " : row.resolved.source === "free" ? "Free default · " : ""}
                          {price(model)}
                        </span>
                      </span>
                    </button>
                  </Row>
                );
              })}
            </List>
            {report.at === null ? null : <Faint>Last changed {new Date(report.at).toLocaleString()}{report.by ? ` by ${report.by}` : ""}.</Faint>}
          </PageSection>
        </PageBody>
      )}

      {report !== null && picking !== null ? (
        <Picker
          report={report}
          role={picking}
          onClose={() => setPicking(null)}
          onPick={async (id) => {
            if (await save({ roles: { [picking]: id } })) setPicking(null);
          }}
        />
      ) : null}
    </>
  );
}

/** The model list for one role: search, free first, paid when allowed, any id by name, or the default. */
function Picker({ report, role, onClose, onPick }: { report: Report; role: Role; onClose: () => void; onPick: (id: string | null) => void }) {
  const [query, setQuery] = useState("");
  const row = report.roles.find((candidate) => candidate.role === role)!;
  const free = report.catalog.models.filter((model) => model.free);
  const paid = report.freeOnly ? [] : report.catalog.models.filter((model) => !model.free);
  const typed = query.trim();
  const offerTyped = MODEL_ID.test(typed) && !report.catalog.models.some((model) => model.id === typed);
  const forBots = role === "standard" || role === "quick" || role === "deep";
  return (
    <ModelSelector open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModelSelectorContent title={`Model for ${ROLES[role].label}`} className="sm:max-w-[560px]">
        <ModelSelectorInput value={query} onValueChange={setQuery} placeholder="Search models, or type one such as anthropic/claude-sonnet-5" />
        <ModelSelectorList className="max-h-[420px]">
          <ModelSelectorEmpty>{report.freeOnly ? "No free model by that name." : "No model by that name. Type its full id, provider/model, to use it anyway."}</ModelSelectorEmpty>
          {offerTyped && !report.freeOnly ? (
            <ModelSelectorGroup heading="By name">
              <ModelSelectorItem value={`typed ${typed}`} onSelect={() => onPick(typed)}>
                <span className="text-[13px]">
                  Use <code className="font-mono">{typed}</code>
                </span>
                <span className="ml-auto text-[11.5px] text-faint">not in Gateway&apos;s list</span>
              </ModelSelectorItem>
            </ModelSelectorGroup>
          ) : null}
          <ModelSelectorGroup heading="Default">
            <ModelSelectorItem value={`default ${row.default}`} onSelect={() => onPick(null)}>
              <span className="text-[13px]">{report.freeOnly ? "The free default" : "The deployment's default"}</span>
              <code className="ml-auto truncate font-mono text-[11.5px] text-faint">{report.freeOnly ? (report.freeDefault?.id ?? "") : row.default}</code>
            </ModelSelectorItem>
          </ModelSelectorGroup>
          {free.length === 0 ? null : (
            <>
              <ModelSelectorSeparator />
              <ModelSelectorGroup heading="Free">
                {free.map((model) => (
                  <Option key={model.id} model={model} current={row.resolved.id === model.id} needsVision={forBots} onPick={onPick} />
                ))}
              </ModelSelectorGroup>
            </>
          )}
          {paid.length === 0 ? null : (
            <>
              <ModelSelectorSeparator />
              <ModelSelectorGroup heading="Paid, cheapest first">
                {paid.map((model) => (
                  <Option key={model.id} model={model} current={row.resolved.id === model.id} needsVision={forBots} onPick={onPick} />
                ))}
              </ModelSelectorGroup>
            </>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

function Option({ model, current, needsVision, onPick }: { model: CatalogModel; current: boolean; needsVision: boolean; onPick: (id: string) => void }) {
  return (
    <ModelSelectorItem value={`${model.name} ${model.id}`} onSelect={() => onPick(model.id)} className={cn("w-full", current && "bg-accent/60")}>
      <BrandMark label={model.provider} size={22} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px]">{model.name}</span>
        <code className="truncate font-mono text-[11px] text-faint">{model.id}</code>
      </span>
      <span className="ml-auto flex flex-none items-center gap-2 text-[11.5px] text-muted-foreground">
        {model.vision ? <EyeIcon className="size-3.5" aria-label="Sees images" /> : needsVision ? <span className="text-faint">text only</span> : null}
        <span className={cn(model.free && "font-medium text-success")}>{price(model)}</span>
      </span>
    </ModelSelectorItem>
  );
}

/** A boxed list of settings rows, as on the Connectors page. */
function List({ children }: { children: ReactNode }) {
  return <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[14px] border border-input bg-card">{children}</div>;
}

function Row({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-[13px]", className)}>{children}</div>;
}

function RowMain({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <b className="font-medium">{title}</b>
      {children === undefined ? null : <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{children}</span>}
    </span>
  );
}
