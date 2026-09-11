import type { Board, FileRef, Member, Presence, Routine } from "../../agent/lib/board";
import type { ActivityEvent } from "../../agent/lib/types";

/** The console renders exactly what the agent's board route returns. */
export type { ActivityEvent, Board, FileRef, Member, Presence, Routine };

export interface BoardResponse extends Board {
  readonly user: string;
}

/** An avatar the pointer is over, and where to anchor its card. */
export interface Hover {
  readonly member: Member;
  readonly rect: DOMRect;
}
