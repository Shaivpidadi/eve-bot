import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { describe, expect, it } from "vitest";

import { isProjectWorker } from "../agent/lib/worker";

/** The background worker's pass is open only to this project's own production daemon. */

const ISSUER = "https://oidc.vercel.com/acme";
const env = { VERCEL_PROJECT_ID: "prj_mine" };

let keysFor: (issuer: string) => JWTVerifyGetKey;

/** Signs as Vercel's issuer would; the key set is served only for that issuer. */
async function signer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  keysFor = (issuer) => {
    if (issuer !== ISSUER) throw new Error(`no keys for ${issuer}`);
    return createLocalJWKSet({ keys: [jwk] });
  };
  return (claims: Record<string, unknown>, issuer = ISSUER) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

const asked = (token: string) => new Request("https://bot.example/bot/v1/internal/tick", { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("isProjectWorker", () => {
  it("accepts a token Vercel issued to this project's production environment", async () => {
    const sign = await signer();
    expect(await isProjectWorker(asked(await sign({ project_id: "prj_mine", environment: "production" })), env, keysFor)).toBe(true);
  });

  it("refuses another project, a preview, a forged issuer, or no token", async () => {
    const sign = await signer();
    expect(await isProjectWorker(asked(await sign({ project_id: "prj_other", environment: "production" })), env, keysFor)).toBe(false);
    expect(await isProjectWorker(asked(await sign({ project_id: "prj_mine", environment: "preview" })), env, keysFor)).toBe(false);
    expect(await isProjectWorker(asked(await sign({ project_id: "prj_mine", environment: "production" }, "https://evil.example")), env, keysFor)).toBe(false);
    expect(await isProjectWorker(new Request("https://bot.example/x", { method: "POST" }), env, keysFor)).toBe(false);
    expect(await isProjectWorker(asked("not-a-jwt"), env, keysFor)).toBe(false);
  });

  it("is never true off Vercel", async () => {
    const sign = await signer();
    expect(await isProjectWorker(asked(await sign({ project_id: "prj_mine", environment: "production" })), {}, keysFor)).toBe(false);
  });
});
