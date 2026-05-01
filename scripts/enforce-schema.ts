import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Agent, CursorAgentError } from "@cursor/sdk";

const SCHEMA_REL = "src/integrations/supabase/types.ts";
const RULES_REL = ".cursorrules";

const TENANT_TABLES = [
  "profiles",
  "projects",
  "volunteer_reviews",
  "announcements",
];

const BANNED_ANALYTICS_PACKAGES = [
  "mixpanel",
  "mixpanel-browser",
  "@sentry/browser",
  "@sentry/react",
  "@sentry/nextjs",
  "@sentry/node",
  "amplitude-js",
  "@amplitude/analytics-browser",
  "posthog-js",
  "segment",
  "@segment/analytics-next",
  "hubspot",
  "@hubspot/api-client",
];

const KEY_HELP = `
[enforce-schema] CURSOR_API_KEY is not set.

To generate one:
  1. Open Cursor → Cursor Settings → "API Keys" tab
     (or visit https://cursor.com/dashboard/cloud-agents/api-keys)
  2. Click "Create new key", name it something like "sdk-pre-commit"
  3. Copy the key value (starts with "cursor_...")
  4. Add it to the .env file at the root of this repo:
       CURSOR_API_KEY=cursor_...
     Or export it in your current shell:
       PowerShell:  $env:CURSOR_API_KEY = "cursor_..."
       bash/zsh:    export CURSOR_API_KEY=cursor_...

The pre-commit hook will skip the review until the key is set.
`;

function getStagedDiff(cwd: string): string {
  return execFileSync("git", ["diff", "--staged", "--no-color"], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readContext(
  absPath: string,
  label: string,
): { text: string; present: boolean } {
  if (!existsSync(absPath)) {
    return {
      text: `(no ${label} file at ${absPath} — auditor should note this.)`,
      present: false,
    };
  }
  return { text: readFileSync(absPath, "utf-8"), present: true };
}

function buildPrompt(args: {
  diff: string;
  schema: string;
  rules: string;
  schemaPath: string;
  rulesPath: string;
}): string {
  const tables = TENANT_TABLES.map((t) => `\`${t}\``).join(", ");
  const bannedPkgs = BANNED_ANALYTICS_PACKAGES.map((p) => `\`${p}\``).join(", ");
  return [
    "You are the **New Zamn Security Auditor**. Compare the staged code changes",
    "against the Constitutional Rules and the Schema. Be strict, terse, specific.",
    "",
    "# Project Constitutional Rules (verbatim)",
    `(loaded from ${args.rulesPath})`,
    "```",
    args.rules,
    "```",
    "",
    "# Current Database Schema",
    `(loaded from ${args.schemaPath})`,
    "```typescript",
    args.schema,
    "```",
    "",
    "# Hard Rules to Enforce (each violation => BLOCK)",
    "",
    `**RULE-1 Tenant Check** — Any query (Supabase client \`.from(...)\` chain or`,
    `   raw SQL) against ${tables} MUST be tenant-scoped:`,
    "   - Reads / updates / deletes (`.select`, `.update`, `.delete`):",
    "     a `.eq('tenant_id', ...)` (or `.in('tenant_id', ...)`, `.match({ tenant_id: ... })`)",
    "     somewhere in the chain.",
    "   - Inserts (`.insert(...)` / `.upsert(...)`): every row in the payload",
    "     MUST contain a `tenant_id` field. Inserts do NOT need a `.eq()`.",
    "   - Raw SQL: a `WHERE tenant_id = ...` clause for reads/writes,",
    "     or an explicit `tenant_id` column in `INSERT INTO ... VALUES (...)`.",
    "",
    "**RULE-2 Type Match** — If the staged code references a table or column",
    "   name that does NOT exist in the Schema above, flag it. This includes:",
    "   - `.from('table_that_isnt_in_schema')`",
    "   - `.select('column_that_isnt_in_schema')` / `.eq('bad_col', ...)` / etc.",
    "   - Object keys passed to `.insert(...)` / `.update(...)` not in the schema.",
    "",
    `**RULE-3 No Soft-Archive Bypass** — Any \`.delete()\` call or raw SQL`,
    `   \`DELETE\` against ${tables} is forbidden. Archival must use`,
    "   `.update({ archived_at: ... })` instead.",
    "",
    "**RULE-4 Audit Trail (volunteer status)** — Any `.update(...)` on",
    "   `volunteer_reviews` that changes a status-shaped column",
    "   (`status`, `state`, `decision`, `verdict`, `rating` if used as a verdict, etc.)",
    "   MUST also set `reviewer_id`. Updates that change such a column without",
    "   recording who made the change are violations.",
    "",
    "**RULE-5 No External Analytics SDKs** — The following packages are banned",
    `   under the Zero-Leak Policy: ${bannedPkgs}.`,
    "   Flag any new `import` / `require` / `from '...'` that pulls one of them in.",
    "   Also flag any newly added `<script src=\"...\">` tags pointing at their CDNs.",
    "",
    "**RULE-6 No PII in URLs or Logs** — Never expose `tenant_id` or `user_id`",
    "   to the public surface. Flag any newly added line that:",
    "   - Embeds `tenant_id` or `user_id` into a URL path or query string",
    "     (e.g. `/orgs/${tenantId}/...`, `?user_id=...`, `router.push` / `navigate(...)`",
    "     building such a URL).",
    "   - Logs them via `console.log/info/debug/error/warn` or a logger call.",
    "",
    "# Soft Rules from .cursorrules",
    "",
    "Apply the rest of the Constitutional Rules above (Profitability, Tech Stack,",
    "AI Privacy, Data Residency, etc.) as discretionary checks. If a staged change",
    "*clearly* violates one — e.g. adds a 30-second `setInterval` polling loop",
    "where a Supabase channel/edge-function trigger would do the job, hardcodes",
    "an organization name into a shared component, or sends raw PII to an external",
    "API — flag it as `[SOFT]` and treat it as BLOCK. Do not nag for borderline",
    "cases or stylistic preferences.",
    "",
    "# Staged Diff",
    "```diff",
    args.diff,
    "```",
    "",
    "# Output Format (MANDATORY)",
    "",
    "For each finding, output one line:",
    "  `<file>:<line> [RULE-N] <short description>`",
    "  (use `[SOFT]` for soft-rule findings rather than a numeric rule.)",
    "",
    "Use your tools to verify line numbers or inspect referenced helpers when",
    "the diff alone is ambiguous. Do NOT speculate. If something is ambiguous",
    "after a tool check, say so and treat it as a violation.",
    "",
    "End your response with EXACTLY one of these tokens on its own line, last:",
    "  - `APPROVE` — no rule violations.",
    "  - `BLOCK`   — at least one rule violated, OR the diff could not be audited.",
  ].join("\n");
}

async function main() {
  const cwd = process.argv[2] ?? process.cwd();

  loadDotenv({ path: join(cwd, ".env"), override: false, quiet: true });

  const diff = getStagedDiff(cwd);
  if (!diff.trim()) {
    console.log("[enforce-schema] no staged changes — nothing to review.");
    process.exit(0);
  }

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error(KEY_HELP);
    process.exit(0);
  }

  const schemaAbs = join(cwd, SCHEMA_REL);
  const rulesAbs = join(cwd, RULES_REL);
  const schema = readContext(schemaAbs, "schema");
  const rules = readContext(rulesAbs, "rules");

  if (!schema.present) {
    console.warn(
      `[enforce-schema] WARN: ${SCHEMA_REL} not found — type-match check will be limited.`,
    );
  }
  if (!rules.present) {
    console.warn(
      `[enforce-schema] WARN: ${RULES_REL} not found — global rules will be skipped.`,
    );
  }

  await using agent = await Agent.create({
    apiKey,
    model: { id: "composer-2" },
    local: { cwd },
  });
  console.log(`[enforce-schema] agent=${agent.agentId}`);

  try {
    const run = await agent.send(
      buildPrompt({
        diff,
        schema: schema.text,
        rules: rules.text,
        schemaPath: SCHEMA_REL,
        rulesPath: RULES_REL,
      }),
    );
    console.log(`[enforce-schema] run=${run.id}\n`);

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
        console.log(`\n[enforce-schema] tool: ${event.name} -> ${event.status}`);
      }
    }
    process.stdout.write("\n");

    const result = await run.wait();
    if (result.status !== "finished") {
      console.error(
        `\n[enforce-schema] run ended as ${result.status}; treating as BLOCK.`,
      );
      process.exit(2);
    }

    const verdict = transcript
      .trimEnd()
      .split(/\r?\n/)
      .reverse()
      .find((line) => /^(APPROVE|BLOCK)\b/.test(line.trim()));

    if (verdict?.trim().startsWith("APPROVE")) {
      console.log("\n[enforce-schema] APPROVED");
      process.exit(0);
    }

    console.error(
      "\n[enforce-schema] BLOCKED — fix the issues above, then re-stage and retry.\n" +
        "                  Bypass once with: git commit --no-verify",
    );
    process.exit(2);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`\n[enforce-schema] startup failed: ${err.message}`);
      process.exit(err.isRetryable ? 75 : 1);
    }
    throw err;
  }
}

main();
