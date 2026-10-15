import { describe, expect, it } from "vitest";

import { connectorConnection } from "../agent/lib/connector-connection";
import type { Connector } from "../agent/lib/connectors";
// eve's own check of a dynamic connection, the one that failed every session start with an
// OAuth connector connected ("The auth field Unknown key ..."). Imported by path: eve does
// not export it, and this test exists to run exactly what eve runs.
import { resolveDynamicConnectionValue } from "../node_modules/eve/dist/src/runtime/resolve-connection.js";

/**
 * Every connection the connectors module hands eve must pass eve's own
 * validation, for every kind of key and both audiences. A field eve does not
 * accept fails the resolver at session start, and with it every turn.
 */
const connector = (auth: Connector["auth"]): Connector =>
  ({
    id: "conn_1",
    workspaceId: "default",
    name: "linear",
    label: "Linear",
    catalog: "linear",
    url: "https://mcp.linear.app/mcp",
    description: "Issues and projects.",
    auth,
    enabled: true,
    gate: "writes",
    policy: { list_issues: "read", create_issue: "write" },
    reviewed: ["list_issues"],
    check: { ok: true, tools: ["list_issues", "create_issue"], at: "2026-10-14T00:00:00.000Z" },
    createdAt: "2026-10-14T00:00:00.000Z",
    createdBy: "operator",
  }) as unknown as Connector;

const kinds: Record<string, Connector["auth"]> = {
  oauth: { kind: "oauth", sealed: null } as unknown as Connector["auth"],
  bearer: { kind: "bearer", sealed: "x" } as unknown as Connector["auth"],
};

describe("connector connections pass eve's validation", () => {
  for (const [kind, auth] of Object.entries(kinds)) {
    for (const audience of ["hq", "bot"] as const) {
      it(`${kind} key, for ${audience}`, () => {
        const definition = connectorConnection(connector(auth), audience);
        expect(definition).not.toBeNull();
        expect(() =>
          resolveDynamicConnectionValue(definition, { connectionName: "linear", logicalPath: "connections/connectors.ts", sourceId: "test", exportName: "default" } as never),
        ).not.toThrow();
      });
    }
  }
});
