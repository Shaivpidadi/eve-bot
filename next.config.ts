import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import { withEve } from "eve/next";
import type { NextConfig } from "next";

/**
 * The console is this Next.js app; its API is the agent's ops channel, mounted
 * at /bot/v1. `withEve` forwards eve's own /eve/v1 routes to the agent, and the
 * helpers below extend exactly that forwarding to the console routes: as a
 * rewrite locally, and as a Build Output route to the eve service on Vercel.
 */
const CONSOLE_API = "/bot/v1";
const EVE_API = "/eve/v1";

/**
 * Hosts other devices may use to reach `next dev`: this machine's LAN
 * addresses, plus anything in BOT_DEV_ORIGINS (comma-separated). Next blocks
 * cross-origin requests to dev-only assets otherwise.
 */
function devOrigins(): string[] {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry?.address ?? "");
  const extra = (process.env.BOT_DEV_ORIGINS ?? "").split(",").map((host) => host.trim());
  return [...new Set([...lan, ...extra].filter((host) => host !== ""))];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
  async headers() {
    return [
      {
        source: "/bot/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

const withAgent = withEve(nextConfig);

type Rewrites = Awaited<ReturnType<NonNullable<NextConfig["rewrites"]>>>;

/** Mirrors withEve's /eve/v1 rule for the console API, pointing at the same agent server. */
function withConsoleRewrite(rules: Rewrites): Rewrites {
  const sections = Array.isArray(rules) ? { afterFiles: rules } : rules;
  const eveRule = [...(sections.beforeFiles ?? []), ...(sections.afterFiles ?? [])].find((rule) =>
    rule.destination.endsWith(`${EVE_API}/:path+`),
  );
  if (eveRule === undefined) return rules;

  const origin = eveRule.destination.slice(0, -`${EVE_API}/:path+`.length);
  return {
    ...sections,
    beforeFiles: [
      { source: `${CONSOLE_API}/:path+`, destination: `${origin}${CONSOLE_API}/:path+` },
      ...(sections.beforeFiles ?? []),
    ],
  };
}

interface VercelRoute {
  src?: string;
  destination?: { type?: string; service?: string };
  transforms?: unknown[];
  handle?: string;
}

interface VercelOutputConfig {
  routes?: VercelRoute[];
  services?: Record<string, { routes?: VercelRoute[] } & Record<string, unknown>>;
}

/** The nearest `<ancestor>/<name>` holding `file`, walking up from `start`. */
function closestDirectoryWithFile(start: string, name: string, file: string): string | null {
  for (let current = start; ; current = dirname(current)) {
    const candidate = join(current, name);
    if (existsSync(join(candidate, file))) return candidate;
    if (dirname(current) === current) return null;
  }
}

/**
 * Where withEve writes the Build Output config, resolved the way eve resolves
 * it: the build's own output directory when there is one (on Vercel's builders
 * that is /vercel/output, found by its builds.json), else the linked project's
 * .vercel/output, else this app's.
 */
function vercelOutputConfigPath(root: string): string {
  const output = closestDirectoryWithFile(root, "output", "builds.json");
  if (output !== null) return join(output, "config.json");
  const linked = closestDirectoryWithFile(root, ".vercel", "project.json");
  return join(linked ?? join(root, ".vercel"), "output", "config.json");
}

/**
 * On Vercel, withEve writes Build Output routes that send /eve/v1 to the eve
 * service, plus a service route that keeps the request path. This adds the same
 * pair for the console API, next to eve's own.
 */
function routeConsoleToAgentService(): void {
  const path = vercelOutputConfigPath(process.cwd());
  const missing = (why: string) =>
    console.warn(`[bot] ${CONSOLE_API} is not routed to the agent (${why}); the console API will answer 404.`);
  if (!existsSync(path)) return missing(`no Build Output config at ${path}`);

  const config = JSON.parse(readFileSync(path, "utf8")) as VercelOutputConfig;
  const eveSrc = `^${EVE_API}/(.*)$`;
  const consoleSrc = `^${CONSOLE_API}/(.*)$`;
  const routes = config.routes ?? [];
  const eveRoute = routes.find((route) => route.src === eveSrc && route.destination?.type === "service");
  const serviceName = eveRoute?.destination?.service;
  if (eveRoute === undefined || serviceName === undefined) return missing(`no ${EVE_API} service route in ${path}`);
  const service = config.services?.[serviceName];
  if (service === undefined) return missing(`no "${serviceName}" service in ${path}`);

  if (!routes.some((route) => route.src === consoleSrc)) {
    routes.splice(routes.indexOf(eveRoute), 0, { src: consoleSrc, destination: eveRoute.destination });
  }
  const serviceRoutes = service.routes ?? [];
  if (!serviceRoutes.some((route) => route.src === consoleSrc)) {
    serviceRoutes.unshift({
      src: consoleSrc,
      transforms: [{ args: `${CONSOLE_API}/$1`, op: "set", type: "request.path" }],
    });
  }

  const next = {
    ...config,
    routes,
    services: { ...config.services, [serviceName]: { ...service, routes: serviceRoutes } },
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

export default async function config(
  phase: string,
  context: { defaultConfig: NextConfig },
): Promise<NextConfig> {
  const resolved = await withAgent(phase, context);
  if (process.env.VERCEL) {
    routeConsoleToAgentService();
    return resolved;
  }
  const rewrites = resolved.rewrites;
  if (rewrites === undefined) return resolved;
  return { ...resolved, rewrites: async () => withConsoleRewrite(await rewrites()) };
}
