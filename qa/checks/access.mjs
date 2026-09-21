import { expect } from "../harness.mjs";

/**
 * The console API is the whole product's front door. If it answers without a
 * token, everything else here is moot.
 */
export default [
  {
    name: "access: no token is refused",
    run: async ({ call }) => {
      const anonymous = await call("/bot/v1/state", { anonymous: true });
      expect(anonymous.status, (status) => status === 401 || status === 503, "an unauthenticated read", {
        status: anonymous.status,
        body: anonymous.body,
      });
      return `answered ${anonymous.status}`;
    },
  },
  {
    name: "access: a wrong token is refused",
    run: async ({ call }) => {
      const wrong = await call("/bot/v1/state", { headers: { authorization: "Bearer not-the-token" } });
      expect(wrong.status, 401, "a read with the wrong token", { body: wrong.body });
    },
  },
  {
    name: "access: the token opens the workspace",
    run: async ({ call }) => {
      const state = await call("/bot/v1/state");
      expect(state.status, 200, "a read with the token", { body: state.body });
      expect(Array.isArray(state.body?.members), true, "the state has a roster", { body: state.body });
      return `${state.body.members.length} members`;
    },
  },
];
