import { execFileSync } from "node:child_process";
import { Agent, CursorAgentError } from "@cursor/sdk";

function getStagedDiff(targetCwd: string): string {
  try {
    return execFileSync("git", ["diff", "--staged", "--no-color"], {
      cwd: targetCwd,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git diff --staged failed: ${message}`);
  }
}

function buildPrompt(diff: string): string {
  return [
    "You are reviewing staged git changes before they are committed.",
    "",
    "Goals:",
    "1. Flag concrete correctness, security, or readability issues. Be specific (file + line).",
    "2. If the diff looks clean, say so in one line — do not invent issues.",
    "3. End your response with a single token on its own line: APPROVE or BLOCK.",
    "   - APPROVE = safe to commit.",
    "   - BLOCK   = at least one issue should be fixed first.",
    "",
    "Staged diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

async function main() {
  const cwd = process.argv[2] ?? process.cwd();
  const diff = getStagedDiff(cwd);
  if (!diff.trim()) {
    console.log("[review] no staged changes — nothing to review.");
    process.exit(0);
  }

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.warn("[review] CURSOR_API_KEY not set — skipping review.");
    process.exit(0);
  }

  await using agent = await Agent.create({
    apiKey,
    model: { id: "composer-2" },
    local: { cwd },
  });

  console.log(`[review] agent=${agent.agentId}`);

  try {
    const run = await agent.send(buildPrompt(diff));
    console.log(`[review] run=${run.id}\n`);

    let transcript = "";
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
            transcript += block.text;
          }
        }
      } else if (event.type === "tool_call" && event.status !== "running") {
        console.log(`\n[review] tool: ${event.name} -> ${event.status}`);
      }
    }
    process.stdout.write("\n");

    const result = await run.wait();
    if (result.status !== "finished") {
      console.error(`\n[review] run ended as ${result.status}; treat as BLOCK.`);
      process.exit(2);
    }

    const verdict = transcript
      .trimEnd()
      .split(/\r?\n/)
      .reverse()
      .find((line) => /^(APPROVE|BLOCK)\b/.test(line.trim()));

    if (verdict?.trim().startsWith("APPROVE")) {
      const took = result.durationMs ? ` in ${result.durationMs}ms` : "";
      console.log(`\n[review] APPROVED${took}`);
      process.exit(0);
    }
    console.error(`\n[review] BLOCKED — fix issues above, then re-stage and retry.`);
    process.exit(2);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`\n[review] startup failed: ${err.message}`);
      process.exit(err.isRetryable ? 75 : 1);
    }
    throw err;
  }
}

main();
