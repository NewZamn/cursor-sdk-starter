import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const SCHEMA_HOTWORDS: { name: string; re: RegExp }[] = [
  { name: "ALTER TABLE", re: /\bALTER\s+TABLE\b/i },
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { name: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/i },
  { name: "CREATE TABLE", re: /\bCREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\b/i },
  { name: "CREATE POLICY", re: /\bCREATE\s+POLICY\b/i },
  { name: "ALTER POLICY", re: /\bALTER\s+POLICY\b/i },
  { name: "DROP POLICY", re: /\bDROP\s+POLICY\b/i },
  { name: "ENABLE RLS", re: /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i },
  { name: "DISABLE RLS", re: /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i },
  { name: "CREATE/REPLACE FUNCTION", re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i },
  { name: "GRANT", re: /\bGRANT\s+/i },
  { name: "REVOKE", re: /\bREVOKE\s+/i },
];

const MCP_HOTWORDS: { name: string; re: RegExp }[] = [
  { name: "apply_migration(...)", re: /\bapply_migration\s*\(/ },
  { name: "execute_sql(...)", re: /\bexecute_sql\s*\(/ },
  { name: "supabase.rpc('exec_sql', ...)", re: /\.rpc\(\s*['"](?:exec_sql|execute_sql)['"]/i },
];

/** Markdown / prose mentions ALTER TABLE in docs — migrations are handled separately. */
function shouldScanSqlHotwords(file: string): boolean {
  if (file.startsWith("supabase/migrations/")) return false;
  const base = file.split("/").pop() ?? file;
  if (base === ".cursorrules") return false;
  if (/\.(md|mdx|txt)$/i.test(file)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|sql)$/i.test(file);
}

/** Skip JSDoc / line-comment lines so tooling sources don't self-trigger the gate. */
function isLikelyCommentOnlyLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/");
}

interface Finding {
  reason: string;
  path?: string;
  evidence: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function getStagedFiles(cwd: string): { status: string; path: string }[] {
  const out = git(["diff", "--cached", "--name-status", "-z"], cwd);
  const parts = out.split("\0").filter(Boolean);
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    files.push({ status: parts[i] ?? "?", path: parts[i + 1] ?? "" });
  }
  return files;
}

function getStagedAddedLines(cwd: string): { file: string; line: string }[] {
  const diff = git(["diff", "--cached", "--no-color", "-U0"], cwd);
  const lines = diff.split(/\r?\n/);
  const out: { file: string; line: string }[] = [];
  let currentFile = "";
  for (const l of lines) {
    if (l.startsWith("+++ b/")) {
      currentFile = l.slice("+++ b/".length);
    } else if (l.startsWith("+") && !l.startsWith("+++")) {
      out.push({ file: currentFile, line: l.slice(1) });
    }
  }
  return out;
}

function detectMajorChanges(cwd: string): Finding[] {
  const findings: Finding[] = [];

  for (const f of getStagedFiles(cwd)) {
    if (
      f.path.startsWith("supabase/migrations/") &&
      f.path.toLowerCase().endsWith(".sql")
    ) {
      let body = "";
      try {
        body = git(["show", `:${f.path}`], cwd);
      } catch {
        try {
          body = git(["show", `HEAD:${f.path}`], cwd);
        } catch {
          body = "(unable to read file content)";
        }
      }
      findings.push({
        reason: `Migration ${f.status} ${f.path}`,
        path: f.path,
        evidence: body,
      });
    }
  }

  const added = getStagedAddedLines(cwd);
  const byFile = new Map<string, string[]>();
  for (const a of added) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file)!.push(a.line);
  }

  for (const [file, rawLines] of byFile) {
    if (!shouldScanSqlHotwords(file)) continue;
    const lines = rawLines.filter((l) => !isLikelyCommentOnlyLine(l));
    const text = lines.join("\n");
    for (const hw of [...SCHEMA_HOTWORDS, ...MCP_HOTWORDS]) {
      if (hw.re.test(text)) {
        const matchedLines = lines.filter((l) => hw.re.test(l));
        findings.push({
          reason: `${hw.name} in ${file}`,
          path: file,
          evidence: matchedLines.map((l) => `+ ${l}`).join("\n"),
        });
      }
    }
  }

  return findings;
}

function printSummary(findings: Finding[]): void {
  process.stderr.write(
    "\n========================================================================\n",
  );
  process.stderr.write(" New Zamn Authorisation Gate\n");
  process.stderr.write(
    `   ${findings.length} major schema change indicator(s) in this commit\n`,
  );
  process.stderr.write(
    "========================================================================\n",
  );
  for (const f of findings) {
    process.stderr.write(`\n--- ${f.reason} ---\n`);
    const lines = f.evidence.split(/\r?\n/);
    const trimmed = lines.length > 200 ? [...lines.slice(0, 200), "  ... (truncated)"] : lines;
    for (const l of trimmed) process.stderr.write(`  ${l}\n`);
  }
  process.stderr.write(
    "\n========================================================================\n",
  );
  process.stderr.write(" Review the SQL/code above CAREFULLY.\n");
  process.stderr.write(" This gate is required by .cursorrules §3.2 (Human Gate).\n");
  process.stderr.write(
    "========================================================================\n",
  );
}

function readTtyLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("not-a-tty"));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const cwd = process.argv[2] ?? process.cwd();
  const findings = detectMajorChanges(cwd);

  if (findings.length === 0) {
    process.exit(0);
  }

  printSummary(findings);

  let answer: string;
  try {
    answer = await readTtyLine(
      '\n[auth-gate] Type "APPROVE" exactly to authorise, anything else to abort: ',
    );
  } catch (err) {
    if (err instanceof Error && err.message === "not-a-tty") {
      process.stderr.write(
        "\n[auth-gate] Approval requires an interactive terminal; this shell is not a TTY.\n",
      );
      process.stderr.write(
        "[auth-gate] If you are certain, bypass once with: git commit --no-verify\n",
      );
      process.exit(2);
    }
    throw err;
  }

  if (answer.trim() === "APPROVE") {
    process.stderr.write("\n[auth-gate] APPROVED — proceeding to schema audit.\n");
    process.exit(0);
  }

  process.stderr.write("\n[auth-gate] DENIED — commit refused.\n");
  process.exit(2);
}

main().catch((err) => {
  console.error("[auth-gate] error:", err);
  process.exit(1);
});
