"use client";

import { useState } from "react";

import { Avatar } from "./avatar";
import { shortWhen, withoutEmoji } from "./format";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import type { Hover, Member } from "./types";

export function Sidebar({
  members,
  selectedId,
  user,
  workspaceId,
  onSelect,
  onHire,
  onPlugins,
  onMemory,
  onHover,
}: {
  members: readonly Member[];
  selectedId: string;
  user: string;
  workspaceId: string;
  onSelect: (id: string) => void;
  onHire: () => void;
  onPlugins: () => void;
  onMemory: () => void;
  onHover: (hover: Hover | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [theme, toggleTheme] = useTheme();

  const needle = query.trim().toLowerCase();
  const rows = members.filter(
    (member) =>
      needle === "" ||
      member.name.toLowerCase().includes(needle) ||
      member.title.toLowerCase().includes(needle) ||
      (member.preview?.text ?? "").toLowerCase().includes(needle),
  );

  return (
    <aside className="sidebar" aria-label="Your Bots">
      <div className="side-top">
        <button type="button" className="icon-btn" aria-label="New Bot" title="New Bot" onClick={onHire}>
          <Icon name="plus" />
        </button>
      </div>
      <label className="search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <nav className="roster">
        {rows.length === 0 ? (
          <p className="roster-empty">No Bots match.</p>
        ) : (
          rows.map((member) => {
            const preview = withoutEmoji(member.preview?.text ?? member.title);
            const needsYou = member.pending > 0 || member.presence === "waiting";
            const classes = ["row", needsYou ? "needs" : "", member.status === "paused" ? "paused" : ""];
            return (
              <button
                key={member.id}
                type="button"
                className={classes.filter(Boolean).join(" ")}
                aria-current={member.id === selectedId}
                onClick={() => onSelect(member.id)}
              >
                <Avatar member={member} size={22} onHover={onHover} />
                <span className="row-main">
                  <span className="row-top">
                    <span className="row-name">{member.name}</span>
                    <time>{shortWhen(member.preview?.at)}</time>
                  </span>
                  <span className="row-preview">
                    {member.status === "paused" ? `Paused · ${preview}` : preview}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </nav>

      <div className="side-bottom">
        <button type="button" className="side-item" onClick={onPlugins}>
          <Icon name="plug" />
          Plugins
        </button>
        <button type="button" className="side-item" onClick={onMemory}>
          <Icon name="brain" />
          Memory
        </button>
        <div className="me">
          <span className="me-avatar">{(user || "You").charAt(0).toUpperCase()}</span>
          <span className="me-name">
            {user || "You"} <span className="me-ws">{workspaceId}</span>
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
            onClick={toggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <form method="post" action="/bot/v1/session/end">
            <button type="submit" className="icon-btn" aria-label="Sign out" title="Sign out">
              <Icon name="signout" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
