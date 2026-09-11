import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../../../lib/activity";
import { MAX_ARTIFACT_BYTES, saveArtifact } from "../../../lib/artifacts";
import { attachArtifact, getJob } from "../../../lib/jobs";
import { operator } from "../../../lib/session";

const MEDIA_TYPES: Record<string, string> = {
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
};

export default defineTool({
  description:
    "Copy a file out of your sandbox into durable storage and attach it to the job. Use it for screenshots that prove an action landed, exports, and final drafts — the sandbox is disposable, this is not.",
  inputSchema: z.object({
    jobId: z.string(),
    path: z.string().describe("Path in your sandbox, e.g. work/report.csv or /workspace/shot.png."),
    name: z.string().max(80).optional().describe("Name the operator will see."),
    mediaType: z.string().max(80).optional(),
  }),
  label: { start: ({ path }) => `Save ${path}` },
  async execute({ jobId, path, name, mediaType }, ctx) {
    const who = operator(ctx);
    const job = await getJob(who.workspaceId, jobId);
    if (job === null) return { saved: false as const, reason: `No job ${jobId}.` };

    const sandbox = await ctx.getSandbox();
    const bytes = await sandbox.readBinaryFile({ path });
    if (bytes === null) return { saved: false as const, reason: `${path} does not exist.` };
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      return {
        saved: false as const,
        reason: `${path} is ${bytes.byteLength} bytes; the limit is ${MAX_ARTIFACT_BYTES}. Summarize it, or upload it to the destination system and link it instead.`,
      };
    }

    const fileName = name ?? (path.split("/").pop() ?? "artifact");
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    const artifact = await saveArtifact({
      workspaceId: who.workspaceId,
      name: fileName,
      mediaType: mediaType ?? MEDIA_TYPES[extension] ?? "application/octet-stream",
      bytes,
    });

    await attachArtifact(who.workspaceId, jobId, artifact);
    await record({
      workspaceId: who.workspaceId,
      kind: "job.artifact",
      botId: job.botId,
      jobId,
      text: `Saved ${artifact.name} (${artifact.bytes} bytes).`,
      data: {
        artifactId: artifact.id,
        name: artifact.name,
        mediaType: artifact.mediaType,
        bytes: artifact.bytes,
      },
    });

    return { saved: true as const, artifact };
  },
});
