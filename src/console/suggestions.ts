import type { Member } from "./types";

const HQ = [
  "Hire a Bot to handle inbound sales follow-up",
  "What happened while I was out?",
  "Who is on the team, and what are they doing?",
  "Set up a briefing for me every weekday at 9 AM",
  "Which jobs are waiting on me?",
  "Send me a team update every Friday afternoon",
];

export function suggestionsFor(member: Member): readonly string[] {
  if (member.kind === "hq") return HQ;
  return [
    "What are you working on?",
    "What have you learned about how I like things done?",
    "Every weekday at 9 AM, send me a short briefing",
    "Show me your routines",
    `Pause after this job, ${member.name}`,
  ];
}
