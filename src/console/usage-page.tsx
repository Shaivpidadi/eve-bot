"use client";

import { useCallback, useEffect, useState } from "react";

import { tokens, usd, type UsageLike } from "../../agent/lib/usage-format";
import { api, isRecord, SignedOutError } from "./api";
import { Icon } from "./icons";

interface Line {
  readonly usage: UsageLike;
}

interface Report {
  readonly total: UsageLike;
  readonly hq: UsageLike;
  readonly jev: UsageLike;
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
  readonly updatedAt: string;
}

const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const modelName = (usage: UsageLike) => {
  const names = Object.keys(usage.models);
  return names.length === 0 ? "—" : names.length === 1 ? names[0] : `${names.length} models`;
};
const share = (part: number, whole: number) => (whole <= 0 ? "—" : part > 0 && part / whole < 0.005 ? "<1%" : `${Math.round((part / whole) * 100)}%`);

/**
 * The whole workspace's spend on one page: what it cost in total, by day, by
 * model, by who ran it, and job by job. Figures are the provider's own, so
 * when a provider reports no price the page says so instead of showing $0 as
 * a fact.
 */
export function UsagePage({ onClose }: { onClose: () => void }) {
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

  return (
    <div className="usage-page" role="region" aria-label="Usage">
      <header className="usage-head">
        <button type="button" className="icon-btn" aria-label="Back to the console" title="Back" onClick={onClose}>
          <Icon name="left" size={18} />
        </button>
        <h1>Usage</h1>
        <span className="faint">
          {report === null ? "" : report.updatedAt === "" ? "Nothing spent yet" : `Updated ${when(report.updatedAt)}`}
        </span>
      </header>

      {error !== null ? <p className="error-text usage-error">{error}</p> : null}

      {report === null ? (
        <p className="faint usage-loading">Loading…</p>
      ) : (
        <div className="usage-body">
          <section className="usage-cards">
            <div className="usage-card">
              <span>All time</span>
              <b>{usd(report.total.costUsd)}</b>
              <small>{report.total.steps === 0 ? "no model steps yet" : `${report.total.steps} model ${report.total.steps === 1 ? "step" : "steps"}`}</small>
            </div>
            <div className="usage-card">
              <span>Last 7 days</span>
              <b>{unpriced ? `${tokens(last7)} tokens` : usd(last7)}</b>
              <small>{today === undefined ? "" : `today ${unpriced ? `${tokens(measure(today.usage))} tokens` : usd(today.usage.costUsd)}`}</small>
            </div>
            <div className="usage-card">
              <span>Tokens</span>
              <b>{tokens(report.total.inputTokens + report.total.outputTokens)}</b>
              <small>
                {tokens(report.total.inputTokens)} in · {tokens(report.total.outputTokens)} out
              </small>
            </div>
            <div className="usage-card">
              <span>Prompt cache</span>
              <b>{tokens(report.total.cacheReadTokens)}</b>
              <small>
                read · {tokens(report.total.cacheWriteTokens ?? 0)} written
              </small>
            </div>
            {report.account === null ? null : (
              <div className="usage-card usage-account">
                <span>Gateway account · every project on this key</span>
                <b>{usd(report.account.totalUsedUsd)}</b>
                <small>
                  {usd(report.account.balanceUsd)} credit left · this workspace is {share(report.total.costUsd, report.account.totalUsedUsd)} of it
                </small>
              </div>
            )}
          </section>

          {unpriced ? (
            <p className="usage-note">
              The provider reported no prices, so the figures below are tokens. On a custom endpoint set <code>BOT_MODEL_PRICES</code> (model=input/output, USD per
              million tokens) to see dollars.
            </p>
          ) : null}

          <section className="usage-section">
            <h2>Last 30 days</h2>
            <div className="usage-chart" role="img" aria-label={`Daily ${unpriced ? "tokens" : "spend"} over the last 30 days`}>
              {peak === 0 ? <span className="usage-empty faint">{report.total.steps === 0 ? "Nothing yet" : "Nothing counted by day yet; it starts with the next step"}</span> : null}
              {report.days.map((day) => {
                const value = measure(day.usage);
                const height = peak > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / peak) * 100)) : 0;
                const label = `${shortDay(day.day)}: ${unpriced ? `${tokens(value)} tokens` : usd(value)} · ${day.usage.steps} steps`;
                return (
                  <div key={day.day} className="usage-bar" title={label}>
                    <i style={{ height: `${height}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="usage-axis">
              <span>{shortDay(report.days[0]?.day ?? "")}</span>
              <span>{shortDay(report.days[Math.floor(report.days.length / 2)]?.day ?? "")}</span>
              <span>today</span>
            </div>
          </section>

          <div className="usage-columns">
            <section className="usage-section">
              <h2>By model</h2>
              {report.models.length === 0 ? (
                <p className="faint">{report.total.steps === 0 ? "No model has run a step yet." : "Steps from before this page existed are in the totals only."}</p>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Steps</th>
                      <th>Tokens</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.models.map((row) => (
                      <tr key={row.model}>
                        <td className="usage-name">{row.model}</td>
                        <td>{row.usage.steps}</td>
                        <td>
                          {tokens(row.usage.inputTokens + row.usage.outputTokens)}
                          <small> · {share(row.usage.inputTokens + row.usage.outputTokens, report.total.inputTokens + report.total.outputTokens)}</small>
                        </td>
                        <td>{usd(row.usage.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="usage-section">
              <h2>By who</h2>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th>Steps</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="usage-name">
                      HQ <small>coordinating</small>
                    </td>
                    <td>{report.hq.steps}</td>
                    <td>{tokens(report.hq.inputTokens + report.hq.outputTokens)}</td>
                    <td>
                      {usd(report.hq.costUsd)}
                      <small> · {share(report.hq.costUsd, report.total.costUsd)}</small>
                    </td>
                  </tr>
                  {report.jev.steps === 0 ? null : (
                    <tr>
                      <td className="usage-name">
                        Jev <small>second opinions</small>
                      </td>
                      <td>{report.jev.steps}</td>
                      <td>{tokens(report.jev.inputTokens + report.jev.outputTokens)}</td>
                      <td>
                        {usd(report.jev.costUsd)}
                        <small> · {share(report.jev.costUsd, report.total.costUsd)}</small>
                      </td>
                    </tr>
                  )}
                  {report.bots.map((row) => (
                    <tr key={row.botId}>
                      <td className="usage-name">
                        {row.emoji === null ? "" : `${row.emoji} `}
                        {row.name}
                        {row.retired ? <small> retired</small> : null}
                      </td>
                      <td>{row.usage.steps}</td>
                      <td>{tokens(row.usage.inputTokens + row.usage.outputTokens)}</td>
                      <td>
                        {usd(row.usage.costUsd)}
                        <small> · {share(row.usage.costUsd, report.total.costUsd)}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="usage-section">
            <h2>By job</h2>
            {report.jobs.length === 0 ? (
              <p className="faint">No job has recorded its usage yet. Jobs started before this was kept show nothing.</p>
            ) : (
              <table className="usage-table usage-jobs">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Bot</th>
                    <th>When</th>
                    <th>Model</th>
                    <th>Steps</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.jobs.map((job) => (
                    <tr key={job.id}>
                      <td className="usage-name">
                        {job.title}
                        <small> {job.status}</small>
                      </td>
                      <td>{job.botName}</td>
                      <td>{when(job.at)}</td>
                      <td>{modelName(job.usage)}</td>
                      <td>{job.usage.steps}</td>
                      <td>{tokens(job.usage.inputTokens + job.usage.outputTokens)}</td>
                      <td>{usd(job.usage.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="faint usage-foot">
            Counted from every model step eve reports, as the provider counted it, plus Jev's judgements. HQ's own turns count under HQ; a Bot's steps count
            under the Bot and on the job. Not counted: anything before this ledger existed, eve's own housekeeping calls such as compaction, and other
            projects on the same key, which is why the Gateway account figure runs higher. Daily figures keep 90 days; totals keep forever.
          </p>
        </div>
      )}
    </div>
  );
}
