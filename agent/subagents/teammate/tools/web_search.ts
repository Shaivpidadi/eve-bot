/**
 * A teammate searches the same way HQ does. A subagent inherits none of the
 * root's authored tools, so the choice made in `agent/tools/web_search.ts`
 * (eve's provider-managed search on AI Gateway, your own search service on a
 * custom endpoint, or off) is re-exported here.
 */
export { default } from "../../../tools/web_search";
