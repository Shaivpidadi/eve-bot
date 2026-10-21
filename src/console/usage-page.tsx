"use client";

import { useCallback, useEffect, useState } from "react";

import { tokens, tokenTotal, usd, type UsageLike } from "../../agent/lib/usage-format";
import { api, isRecord, SignedOutError } from "./api";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Bar, BarChart, XAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Line {
  readonly usage: UsageLike;
}

interface Report {
  readonly worker?: { readonly at: string } | null;
  readonly total: UsageLike;
  readonly hq: UsageLike;
  readonly jev: UsageLike;
  readonly memory: UsageLike;
  readonly account: { readonly balanceUsd: number; readonly totalUsedUsd: number; readonly at: string } | null;
  readonly bots: readonly (Line & { readonly botId: string; readonly name: string; readonly emoji: string | null; readonly retired: boolean })[];
  readonly models: readonly (Line & { readonly model: string })[];
  readonly days: readonly (Line & { readonly day: string })[];
  readonly jobs: readonly (Line & {
    readonly id: string;
    readonly title: string;
    readonly botId: string;
    readonly botName: string;
    readonly status: string;
    readonly at: string;
  })[];
  /** This month's workspace budget; absent from servers older than it. */
  readonly budget?: {
    readonly period: string;
    readonly limitUsd: number | null;
    readonly spentUsd: number;
    readonly reservedUsd: number;
    readonly remainingUsd: number | null;
    readonly unknownCostCount: number;
    readonly heldRuns: number;
  };
  readonly updatedAt: string;
}

const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const modelName = (usage: UsageLike) => {
  const names = Object.keys(usage.models);
  return names.length === 0 ? "—" : names.length === 1 ? names[0] : `${names.length} models`;
};
const share = (part: number, whole: number) => (whole <= 0 ? "—" : part > 0 && part / whole < 0.005 ? "<1%" : `${Math.round((part / whole) * 100)}%`);

/*
 * The console's full-page screens (Usage, Memory, Connectors) share one frame:
 * a sticky header with a way back, a centred column, titled sections, and a
 * note box. Exported for the other two pages.
 */

/** A page that replaces the console: header, then a scrolling column. */
export function PageFrame({
  title,
  label,
  onBack,
  backLabel = "Back to the console",
  actions,
  children,
}: {
  title: ReactNode;
  label: string;
  onBack: () => void;
  backLabel?: string;
  /** Whatever sits after the title in the header. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background text-foreground" role="region" aria-label={label}>
      <header className="sticky top-0 z-10 flex h-[52px] items-center gap-2.5 border-b bg-background px-4">
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={backLabel} title="Back" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="m-0 truncate text-[15px] font-semibold">{title}</h1>
        {actions}
      </header>
      {children}
    </div>
  );
}

export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto flex w-full max-w-[1040px] flex-col gap-[26px] px-4 pt-[22px] pb-10 sm:px-5", className)}>{children}</div>;
}

/** A titled part of a page. */
export function PageSection({ title, className, children }: { title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h2 className="m-0 text-xs font-medium text-faint">{title}</h2>
      {children}
    </section>
  );
}

/** A boxed explanation under a page's header. */
export function PageNote({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn("m-0 rounded-[10px] border border-input bg-card px-3 py-2.5 text-[12.5px] text-muted-foreground [&_code]:font-mono [&_code]:text-xs", className)}>
      {children}
    </p>
  );
}

/** Small, quiet text: hints, counts, empty states. */
export function Faint({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("m-0 text-[11.5px] text-faint", className)}>{children}</p>;
}

export function PageError({ children }: { children: ReactNode }) {
  return <p className="m-0 px-4 py-6 text-xs text-destructive">{children}</p>;
}

export function PageLoading() {
  return <p className="m-0 px-4 py-6 text-[11.5px] text-faint">Loading…</p>;
}

function Stat({ label, value, detail, className }: { label: ReactNode; value: ReactNode; detail: ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-1 rounded-xl px-4 py-3.5 ring-input", className)}>
      <span className="text-[11.5px] text-faint">{label}</span>
      <b className="text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">{value}</b>
      <small className="truncate text-[11.5px] text-muted-foreground">{detail}</small>
    </Card>
  );
}

const quiet = "text-[11.5px] text-faint";
const tableCls = "text-[13px] tabular-nums [&_th]:h-auto [&_th]:px-0 [&_th]:pr-2.5 [&_th]:pb-1.5 [&_th]:text-[11.5px] [&_th]:font-medium [&_th]:text-faint [&_td]:px-0 [&_td]:py-2 [&_td]:pr-2.5 [&_td]:align-top [&_th:last-child]:pr-0 [&_th:last-child]:text-right [&_td:last-child]:pr-0 [&_td:last-child]:text-right";
const nameCell = "min-w-[120px] whitespace-normal [overflow-wrap:anywhere]";

const chartConfig = { value: { label: "Spend", color: "var(--brand)" } } satisfies ChartConfig;

/**
 * The whole workspace's spend on one page: what it cost in total, by day, by
 * model, by who ran it, and job by job. Figures are the provider's own, so
 * when a provider reports no price the page says so instead of showing $0 as
 * a fact.
 */
export function UsagePage({ onClose, exportable = false }: { onClose: () => void; exportable?: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/usage");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && isRecord(body.total)) {
        setReport(body as unknown as Report);
        setError(null);
      } else setError("Could not load usage.");
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load usage.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = report?.total;
  const unpriced = total !== undefined && total.steps > 0 && total.costUsd === 0;
  // The chart shows dollars, or tokens where no provider priced anything.
  const measure = (usage: UsageLike) => (unpriced ? usage.inputTokens + usage.outputTokens : usage.costUsd);
  const peak = report === null ? 0 : Math.max(0, ...report.days.map((day) => measure(day.usage)));
  const last7 = report?.days.slice(-7).reduce((sum, day) => sum + measure(day.usage), 0) ?? 0;
  const today = report?.days[report.days.length - 1];
  const daily = (report?.days ?? []).map((day) => ({ day: day.day, value: measure(day.usage), steps: day.usage.steps }));
  const ticks = daily.length === 0 ? [] : [daily[0]!.day, daily[Math.floor(daily.length / 2)]!.day, daily[daily.length - 1]!.day];

  return (
    <PageFrame
      title="Usage"
      label="Usage"
      onBack={onClose}
      actions={
        <span className={cn(quiet, "ml-auto")}>
          {report === null ? "" : report.updatedAt === "" ? "Nothing spent yet" : `Updated ${when(report.updatedAt)}`}
        </span>
      }
    >
      {error !== null ? <PageError>{error}</PageError> : null}

      {report === null ? (
        <PageLoading />
      ) : (
        <PageBody>
          <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <Stat
              label="All time"
              value={usd(report.total.costUsd)}
              detail={report.total.steps === 0 ? "no model steps yet" : `${report.total.steps} model ${report.total.steps === 1 ? "step" : "steps"}`}
            />
            <Stat
              label="Last 7 days"
              value={unpriced ? `${tokens(last7)} tokens` : usd(last7)}
              detail={today === undefined ? "" : `today ${unpriced ? `${tokens(measure(today.usage))} tokens` : usd(today.usage.costUsd)}`}
            />
            <Stat
              label="Tokens"
              value={tokens(report.total.inputTokens + report.total.outputTokens)}
              detail={`${tokens(report.total.inputTokens)} in · ${tokens(report.total.outputTokens)} out`}
            />
            <Stat label="Prompt cache" value={tokens(report.total.cacheReadTokens)} detail={`read · ${tokens(report.total.cacheWriteTokens ?? 0)} written`} />
            {report.budget === undefined ? null : (
              <Stat
                label={`Budget · ${report.budget.period}`}
                value={`${usd(report.budget.spentUsd)}${report.budget.limitUsd === null ? "" : ` of ${usd(report.budget.limitUsd)}`}`}
                detail={[
                  report.budget.limitUsd === null ? "no limit set" : `${usd(report.budget.remainingUsd ?? 0)} left`,
                  report.budget.reservedUsd > 0
                    ? `${usd(report.budget.reservedUsd)} held by ${report.budget.heldRuns} running ${report.budget.heldRuns === 1 ? "job" : "jobs"}`
                    : null,
                  report.budget.unknownCostCount > 0 ? `${report.budget.unknownCostCount} unpriced ${report.budget.unknownCostCount === 1 ? "call" : "calls"}` : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              />
            )}
            {report.account === null ? null : (
              <Stat
                className="col-span-full ring-brand"
                label="Gateway account · every project on this key"
                value={usd(report.account.totalUsedUsd)}
                detail={`${usd(report.account.balanceUsd)} credit left · this workspace is ${share(report.total.costUsd, report.account.totalUsedUsd)} of it`}
              />
            )}
          </section>

          {unpriced ? (
            <PageNote className="-mt-2.5">
              The provider reported no prices, so the figures below are tokens. On a custom endpoint set <code>BOT_MODEL_PRICES</code> (model=input/output, USD per
              million tokens) to see dollars.
            </PageNote>
          ) : null}

          <PageSection title="Last 30 days">
            <Card className="relative gap-0 rounded-xl px-2.5 pt-2 pb-1 ring-input" role="img" aria-label={`Daily ${unpriced ? "tokens" : "spend"} over the last 30 days`}>
              {peak === 0 ? (
                <span className={cn(quiet, "absolute inset-0 flex items-center justify-center")}>
                  {report.total.steps === 0 ? "Nothing yet" : "Nothing counted by day yet; it starts with the next step"}
                </span>
              ) : null}
              <ChartContainer config={chartConfig} className="aspect-auto h-[100px] w-full sm:h-[140px]">
                <BarChart accessibilityLayer data={daily} margin={{ top: 4, right: 14, bottom: 0, left: 14 }} barCategoryGap={2}>
                  <XAxis
                    dataKey="day"
                    ticks={ticks}
                    interval={0}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    fontSize={11}
                    tickFormatter={(day: string) => (day === ticks[2] ? "today" : shortDay(day))}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        hideIndicator
                        labelFormatter={(_, payload) => {
                          const row = payload[0]?.payload as { day: string; steps: number } | undefined;
                          return row === undefined ? "" : `${shortDay(row.day)} · ${row.steps} steps`;
                        }}
                        formatter={(value) => (unpriced ? `${tokens(Number(value))} tokens` : usd(Number(value)))}
                      />
                    }
                  />
                  <Bar dataKey="value" fill="var(--color-value)" fillOpacity={0.85} radius={[3, 3, 0, 0]} minPointSize={0} />
                </BarChart>
              </ChartContainer>
            </Card>
          </PageSection>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <PageSection title="By model">
              {report.models.length === 0 ? (
                <Faint>{report.total.steps === 0 ? "No model has run a step yet." : "Steps from before this page existed are in the totals only."}</Faint>
              ) : (
                <Table className={tableCls}>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Model</TableHead>
                      <TableHead>Steps</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.models.map((row) => (
                      <TableRow key={row.model} className="hover:bg-transparent">
                        <TableCell className={nameCell}>{row.model}</TableCell>
                        <TableCell>{row.usage.steps}</TableCell>
                        <TableCell>
                          {tokens(row.usage.inputTokens + row.usage.outputTokens)}
                          <small className={quiet}> · {share(row.usage.inputTokens + row.usage.outputTokens, report.total.inputTokens + report.total.outputTokens)}</small>
                        </TableCell>
                        <TableCell>{usd(row.usage.costUsd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </PageSection>

            <PageSection title="By who">
              <Table className={tableCls}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Who</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <WhoRow name="HQ" note="coordinating" usage={report.hq} total={report.total} />
                  {report.jev.steps === 0 ? null : <WhoRow name="Jev" note="second opinions" usage={report.jev} total={report.total} />}
                  {report.memory.steps === 0 ? null : <WhoRow name="Memory" note="reading exchanges to remember" usage={report.memory} total={report.total} />}
                  {report.bots.map((row) => (
                    <WhoRow
                      key={row.botId}
                      name={`${row.emoji === null ? "" : `${row.emoji} `}${row.name}`}
                      note={row.retired ? "retired" : null}
                      usage={row.usage}
                      total={report.total}
                    />
                  ))}
                </TableBody>
              </Table>
            </PageSection>
          </div>

          <PageSection title="By job">
            {report.jobs.length === 0 ? (
              <Faint>No job has recorded its usage yet. Jobs started before this was kept show nothing.</Faint>
            ) : (
              <Table className={cn(tableCls, "[&_td]:whitespace-nowrap")}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Job</TableHead>
                    <TableHead>Bot</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.jobs.map((job) => (
                    <TableRow key={job.id} className="hover:bg-transparent">
                      <TableCell className={cn(nameCell, "whitespace-normal!")}>
                        {job.title}
                        <small className={quiet}> {job.status}</small>
                      </TableCell>
                      <TableCell>{job.botName}</TableCell>
                      <TableCell>{when(job.at)}</TableCell>
                      <TableCell>{modelName(job.usage)}</TableCell>
                      <TableCell>{job.usage.steps}</TableCell>
                      <TableCell>{tokenTotal(job.usage)}</TableCell>
                      <TableCell>{usd(job.usage.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </PageSection>

          {report.worker ? <WorkerNote at={report.worker.at} /> : null}
          <Faint className="max-w-[640px]">
            Counted from every model step eve reports, as the provider counted it, plus Jev's judgements. HQ's own turns count under HQ; a Bot's steps count
            under the Bot and on the job. Not counted: anything before this ledger existed, eve's own housekeeping calls such as compaction, and other
            projects on the same key, which is why the Gateway account figure runs higher. Daily figures keep 90 days; totals keep forever.
          </Faint>
          {exportable ? (
            <Faint className="max-w-[640px] [&_a]:text-muted-foreground [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-foreground [&_code]:font-mono">
              <a href="/bot/v1/export" download>
                Export this workspace
              </a>{" "}
              as a file <code>npm run import</code> reads on another deployment or your own machine. Connectors are left out; reconnect them after
              the import, or ask for <a href="/bot/v1/export?secrets=1">an export with them</a> and keep that file like a password.
            </Faint>
          ) : null}
        </PageBody>
      )}
    </PageFrame>
  );
}

function WhoRow({ name, note, usage, total }: { name: string; note: string | null; usage: UsageLike; total: UsageLike }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className={nameCell}>
        {name}
        {note === null ? null : <small className={quiet}> {note}</small>}
      </TableCell>
      <TableCell>{usage.steps}</TableCell>
      <TableCell>{tokenTotal(usage)}</TableCell>
      <TableCell>
        {usd(usage.costUsd)}
        <small className={quiet}> · {share(usage.costUsd, total.costUsd)}</small>
      </TableCell>
    </TableRow>
  );
}

/**
 * The background worker (a Vercel Daemon, see agent/lib/worker.ts) passes every
 * 30 seconds; two minutes without one means it stopped, and the watchdog falls
 * back to the console and the daily cron.
 */
function WorkerNote({ at }: { at: string }) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  const ago = seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
  return (
    <Faint className="max-w-[640px]">
      {seconds <= 120
        ? `Background worker: running, last pass ${ago}. Due work, teammates' notes and idle browsers move without a console open.`
        : `Background worker: not seen for ${ago}. Due work waits for a console or the daily watchdog until it runs again.`}
    </Faint>
  );
}
