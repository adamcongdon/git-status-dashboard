import { readdir, stat, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { createInterface } from "readline/promises";

const CONFIG_PATH = join(import.meta.dir, "config.json");
const PORT = 3847;
const DEBUG = process.argv.includes("--debug");

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}
function dbg(...args: unknown[]) {
  if (DEBUG) console.log(`[DBG ${new Date().toLocaleTimeString()}]`, ...args);
}

interface Config {
  projectDirs: string[];
}

interface RepoInfo {
  name: string;
  path: string;
  folder: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.projectDirs) && parsed.projectDirs.length > 0) {
      return parsed as Config;
    }
  } catch {
    // config missing or invalid
  }
  return await runSetup();
}

async function runSetup(): Promise<Config> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nGit Status Dashboard — First-time setup\n");
  const answer = await rl.question(
    "Enter project directories to scan (comma-separated, default: ~/code):\n> ",
  );
  rl.close();

  const dirs =
    answer.trim() === ""
      ? [join(homedir(), "code")]
      : answer
          .split(",")
          .map((d) => expandHome(d.trim()))
          .filter((d) => d.length > 0);

  const config: Config = { projectDirs: dirs };
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nConfig saved to ${CONFIG_PATH}`);
  console.log(`Scanning directories: ${dirs.join(", ")}\n`);
  return config;
}

async function getGitRepos(config: Config): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];

  for (const dir of config.projectDirs) {
    const resolvedDir = resolve(dir);
    log(`Scanning directory: ${resolvedDir}`);

    let entries;
    try {
      entries = await readdir(resolvedDir, { withFileTypes: true });
    } catch (e: any) {
      log(`WARNING: cannot read ${resolvedDir}: ${e.message}`);
      continue;
    }

    const dirs = entries.filter(e => e.isDirectory());
    dbg(`  ${dirs.length} subdirectories found in ${resolvedDir}`);

    for (const entry of dirs) {
      const fullPath = join(resolvedDir, entry.name);
      const gitDir = join(fullPath, ".git");
      try {
        const s = await stat(gitDir);
        if (s.isDirectory()) {
          dbg(`  Found repo: ${entry.name}`);
          repos.push({ name: entry.name, path: fullPath, folder: resolvedDir });
        }
      } catch {
        dbg(`  Not a repo: ${entry.name}`);
      }
    }

    log(`  Found ${repos.length} git repos in ${resolvedDir}`);
  }

  return repos.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

interface RepoStatus {
  name: string;
  path: string;
  folder: string;
  branch: string;
  uncommitted: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  detached: boolean;
  lastCommitDate: string;
  error?: string;
}

function validateRepoPath(rawPath: unknown, config: Config): { resolved: string } | { error: string; status: number } {
  if (!rawPath || typeof rawPath !== "string" || rawPath.includes("..")) {
    return { error: "Invalid path", status: 400 };
  }
  const resolved = resolve(rawPath);
  const allowed = config.projectDirs.some(
    (dir) => resolved.startsWith(resolve(dir) + "/"),
  );
  if (!allowed) return { error: "Path not in configured directories", status: 403 };
  return { resolved };
}

const INFERENCE_PATH = join(homedir(), ".claude", "PAI", "Tools", "Inference.ts");
let AI_AVAILABLE = false;

async function checkAIAvailable(): Promise<boolean> {
  try {
    await stat(INFERENCE_PATH);
    return true;
  } catch {
    return false;
  }
}

async function runInference(systemPrompt: string, userPrompt: string, timeoutMs = 30000): Promise<string> {
  const proc = Bun.spawn(["bun", INFERENCE_PATH, "--level", "fast", systemPrompt, userPrompt], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const textPromise = new Response(proc.stdout).text();
  const errPromise = new Response(proc.stderr).text();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => { proc.kill(); reject(new Error(`AI inference timed out after ${timeoutMs / 1000}s`)); }, timeoutMs)
  );

  const text = await Promise.race([textPromise, timeout]);
  await proc.exited;
  const trimmed = text.trim();
  if (!trimmed) {
    const errText = await errPromise;
    throw new Error(errText.trim() || "Empty response from AI");
  }
  return trimmed;
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  dbg(`  git ${args.join(" ")}  (in ${repoPath})`);
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  });

  const textPromise = new Response(proc.stdout).text();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => { proc.kill(); reject(new Error(`git ${args[0]} timed out after 5s`)); }, 5000)
  );

  const text = await Promise.race([textPromise, timeout]);
  await proc.exited;
  return text.trim();
}

async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function getRepoStatus(repo: RepoInfo, index: number, total: number): Promise<RepoStatus> {
  const repoPath = repo.path;
  const pad = String(total).length;
  process.stdout.write(`  [${String(index + 1).padStart(pad)}/${total}] ${repo.name} ... `);
  const t = performance.now();
  const status: RepoStatus = {
    name: repo.name,
    path: repo.path,
    folder: repo.folder,
    branch: "",
    uncommitted: 0,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    detached: false,
    lastCommitDate: "",
  };

  try {
    // Run independent git commands in parallel
    const [branch, porcelain, remotes, lastLog] = await Promise.all([
      runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(repoPath, ["status", "--porcelain"]),
      runGit(repoPath, ["remote"]),
      runGit(repoPath, ["log", "-1", "--format=%aI"]).catch(() => ""),
    ]);

    status.branch = branch;
    if (branch === "HEAD") {
      status.detached = true;
    }
    status.uncommitted = porcelain ? porcelain.split("\n").length : 0;
    status.hasRemote = remotes.length > 0;
    status.lastCommitDate = lastLog;

    // Ahead/behind (depends on branch and remote results)
    if (status.hasRemote && !status.detached) {
      try {
        const upstream = await runGit(repoPath, [
          "rev-parse",
          "--abbrev-ref",
          `${branch}@{upstream}`,
        ]);
        if (upstream) {
          const aheadBehind = await runGit(repoPath, [
            "rev-list",
            "--left-right",
            "--count",
            `${branch}...${upstream}`,
          ]);
          const [ahead, behind] = aheadBehind.split("\t").map(Number);
          status.ahead = ahead || 0;
          status.behind = behind || 0;
        }
      } catch {
        // No upstream tracking branch
      }
    }
  } catch (e: any) {
    status.error = e.message || "Unknown error";
  }

  const ms = Math.round(performance.now() - t);
  console.log(status.error ? `error (${ms}ms)` : `${status.branch} (${ms}ms)`);
  return status;
}

function renderHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Git Status Dashboard</title>
<link rel="icon" type="image/jpeg" href="/favicon.jpg">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    padding: 24px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #21262d;
  }
  h1 {
    font-size: 24px;
    font-weight: 600;
    color: #f0f6fc;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .summary {
    font-size: 14px;
    color: #8b949e;
  }
  button {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.15s;
  }
  button:hover { background: #30363d; }
  button:disabled { opacity: 0.5; cursor: wait; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 12px;
  }
  .card {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
    transition: border-color 0.15s;
  }
  .card:hover { border-color: #30363d; }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .repo-name {
    font-size: 16px;
    font-weight: 600;
    color: #58a6ff;
  }
  .branch {
    font-size: 12px;
    background: #1f2937;
    padding: 2px 8px;
    border-radius: 12px;
    color: #8b949e;
  }
  .badges {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 12px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .badge-clean { background: #0d1f0d; color: #3fb950; border: 1px solid #238636; }
  .badge-uncommitted { background: #2a1f00; color: #d29922; border: 1px solid #9e6a03; }
  .badge-ahead { background: #0a1929; color: #58a6ff; border: 1px solid #1f6feb; }
  .badge-behind { background: #290a1f; color: #f778ba; border: 1px solid #db61a2; }
  .badge-no-remote { background: #1f1f1f; color: #8b949e; border: 1px solid #484f58; }
  .badge-detached { background: #2a1500; color: #d29922; border: 1px solid #9e6a03; }
  .badge-error { background: #2d0000; color: #f85149; border: 1px solid #da3633; }
  .badge-stale { background: #1f1f1f; color: #8b949e; border: 1px solid #484f58; }
  .last-commit { font-size: 11px; color: #484f58; margin-top: 6px; }
  .card.clean { border-left: 3px solid #238636; }
  .card.dirty { border-left: 3px solid #d29922; }
  .card.pending { border-left: 3px solid #58a6ff; }
  .card.error-state { border-left: 3px solid #f85149; }
  .loading {
    text-align: center;
    padding: 60px;
    color: #8b949e;
    font-size: 16px;
  }
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid #30363d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .filter-bar {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .filter-btn {
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 16px;
    background: #21262d;
    border: 1px solid #30363d;
    color: #8b949e;
    cursor: pointer;
  }
  .filter-btn.active { background: #1f6feb; color: #f0f6fc; border-color: #1f6feb; }
  .filter-btn .count { margin-left: 4px; opacity: 0.7; }
  .card-actions { margin-top: 10px; display: flex; gap: 8px; }
  .open-btn {
    font-size: 12px;
    padding: 4px 10px;
    background: #1f2937;
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .open-btn:hover { background: #30363d; color: #c9d1d9; }
  .folder-label { font-size: 11px; color: #8b949e; margin-bottom: 6px; }
  #autoRefreshSelect {
    background: #21262d;
    color: #8b949e;
    border: 1px solid #30363d;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  #autoRefreshSelect.active { color: #58a6ff; border-color: #1f6feb; }
  .delete-btn {
    font-size: 12px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid #da3633;
    color: #f85149;
    border-radius: 6px;
    cursor: pointer;
    margin-left: auto;
    transition: background 0.15s, color 0.15s;
  }
  .delete-btn:hover { background: #2d0000; }
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .modal-overlay.visible { display: flex; }
  .modal {
    background: #161b22;
    border: 1px solid #da3633;
    border-radius: 10px;
    padding: 28px 32px;
    max-width: 420px;
    width: 90%;
  }
  .modal h2 { font-size: 18px; color: #f85149; margin-bottom: 8px; }
  .modal p { font-size: 14px; color: #8b949e; margin-bottom: 6px; }
  .modal .repo-path { font-size: 12px; color: #c9d1d9; font-family: monospace; background: #0d1117; padding: 6px 10px; border-radius: 4px; margin-bottom: 20px; word-break: break-all; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .modal-cancel { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .modal-cancel:hover { background: #30363d; }
  .modal-confirm { background: #da3633; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .modal-confirm:hover { background: #f85149; }
  .modal-confirm:disabled { opacity: 0.5; cursor: wait; }
  .status-banner {
    display: none;
    margin-bottom: 16px;
    padding: 10px 16px;
    border-radius: 6px;
    font-size: 13px;
    border: 1px solid #30363d;
    background: #161b22;
    color: #c9d1d9;
    white-space: pre-wrap;
    font-family: monospace;
  }
  .status-banner.success { border-color: #238636; background: #0d1f0d; color: #3fb950; }
  .status-banner.info { border-color: #1f6feb; background: #0a1929; color: #58a6ff; }
  .status-banner.warn { border-color: #9e6a03; background: #2a1f00; color: #d29922; }
  .action-btn {
    font-size: 12px;
    padding: 4px 10px;
    background: #1f2937;
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .action-btn:hover { background: #30363d; color: #c9d1d9; }
  .action-btn:disabled { opacity: 0.5; cursor: wait; }
  .action-btn.pull-btn { border-color: #db61a2; color: #f778ba; }
  .action-btn.pull-btn:hover { background: #290a1f; }
  .action-btn.push-btn { border-color: #1f6feb; color: #58a6ff; }
  .action-btn.push-btn:hover { background: #0a1929; }
  .action-btn.ai-btn { border-color: #8957e5; color: #bc8cff; }
  .action-btn.ai-btn:hover { background: #1a0a2e; }
  .commit-msg-modal .modal { border-color: #1f6feb; max-width: 560px; }
  .commit-msg-modal .modal h2 { color: #58a6ff; }
  .commit-msg-pre {
    background: #0d1117;
    padding: 12px;
    border-radius: 6px;
    font-size: 13px;
    white-space: pre-wrap;
    margin: 12px 0;
    max-height: 300px;
    overflow: auto;
    color: #c9d1d9;
    font-family: monospace;
    border: 1px solid #21262d;
    cursor: text;
    user-select: all;
  }
  .header-ai-btn {
    background: #1a0a2e;
    border-color: #8957e5;
    color: #bc8cff;
  }
  .header-ai-btn:hover { background: #2a1a3e; }
</style>
</head>
<body>
<header>
  <h1><img src="/favicon.jpg" alt="" style="width:32px;height:32px;border-radius:6px;vertical-align:middle;margin-right:10px;">Git Status Dashboard</h1>
  <div class="header-right">
    <span class="summary" id="summary"></span>
    <button onclick="pullAll()" id="pullAllBtn" style="display:none">⬇ Pull All Safe</button>
    <button onclick="aiTriage()" id="triageBtn" class="header-ai-btn" style="display:none">🤖 What needs attention?</button>
    <button onclick="refresh()" id="refreshBtn">Refresh</button>
    <select id="autoRefreshSelect" onchange="setAutoRefresh(this.value)" title="Auto-refresh interval">
      <option value="0">Auto: Off</option>
      <option value="30">Auto: 30s</option>
      <option value="60">Auto: 1m</option>
      <option value="300">Auto: 5m</option>
      <option value="900">Auto: 15m</option>
      <option value="1800">Auto: 30m</option>
    </select>
    <button onclick="updateServer()" id="updateBtn">Check for Updates</button>
    <button onclick="restartServer()" id="restartBtn">Restart Server</button>
  </div>
</header>
<div class="status-banner" id="statusBanner"></div>
<div class="modal-overlay" id="deleteModal">
  <div class="modal">
    <h2>Delete Repository?</h2>
    <p>This will permanently delete the folder from disk. This cannot be undone.</p>
    <div class="repo-path" id="deleteModalPath"></div>
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeDeleteModal()">Cancel</button>
      <button class="modal-confirm" id="deleteConfirmBtn" onclick="confirmDelete()">Delete Forever</button>
    </div>
  </div>
</div>
<div class="modal-overlay commit-msg-modal" id="commitMsgModal">
  <div class="modal">
    <h2>🤖 AI Commit Message</h2>
    <p id="commitMsgRepo" style="font-size:13px; margin-bottom:8px;"></p>
    <pre class="commit-msg-pre" id="commitMsgText"></pre>
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeCommitMsgModal()">Close</button>
      <button class="open-btn" onclick="copyCommitMsg()" id="copyCommitBtn">📋 Copy to Clipboard</button>
    </div>
  </div>
</div>
<div class="filter-bar" id="filters"></div>
<div id="content"><div class="loading"><span class="spinner"></span>Scanning repositories...</div></div>
<script>
let allRepos = [];
let activeFilter = "all";
let aiAvailable = false;

function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

// Check AI availability on load
fetch("/api/config").then(r => r.json()).then(c => {
  aiAvailable = c.aiAvailable || false;
  if (aiAvailable) document.getElementById("triageBtn").style.display = "";
});

async function openInVSCode(path) {
  await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

async function revealInFinder(path) {
  await fetch("/api/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

async function fetchRepos() {
  const res = await fetch("/api/repos?t=" + Date.now());
  return res.json();
}

function getCardClass(repo) {
  if (repo.error) return "error-state";
  if (repo.uncommitted > 0) return "dirty";
  if (repo.ahead > 0 || repo.behind > 0) return "pending";
  return "clean";
}

function renderFilters(repos) {
  const clean = repos.filter(r => !r.error && r.uncommitted === 0 && r.ahead === 0 && r.behind === 0).length;
  const dirty = repos.filter(r => r.uncommitted > 0).length;
  const pending = repos.filter(r => r.ahead > 0 || r.behind > 0).length;
  const noRemote = repos.filter(r => !r.hasRemote).length;
  const errors = repos.filter(r => r.error).length;
  const stale = repos.filter(r => daysSince(r.lastCommitDate) >= 30).length;

  const filters = [
    { id: "all", label: "All", count: repos.length },
    { id: "dirty", label: "Uncommitted", count: dirty },
    { id: "pending", label: "Ahead/Behind", count: pending },
    { id: "clean", label: "Clean", count: clean },
    { id: "no-remote", label: "No Remote", count: noRemote },
  ];
  if (stale > 0) filters.push({ id: "stale", label: "Stale (30d+)", count: stale });
  if (errors > 0) filters.push({ id: "error", label: "Errors", count: errors });

  document.getElementById("filters").innerHTML = filters
    .map(f => '<button class="filter-btn' + (activeFilter === f.id ? ' active' : '') +
      '" onclick="setFilter(\\'' + f.id + '\\')">' + f.label +
      '<span class="count">(' + f.count + ')</span></button>')
    .join("");
}

function setFilter(id) {
  activeFilter = id;
  renderRepos(allRepos);
}

function filterRepos(repos) {
  switch (activeFilter) {
    case "dirty": return repos.filter(r => r.uncommitted > 0);
    case "pending": return repos.filter(r => r.ahead > 0 || r.behind > 0);
    case "clean": return repos.filter(r => !r.error && r.uncommitted === 0 && r.ahead === 0 && r.behind === 0);
    case "no-remote": return repos.filter(r => !r.hasRemote);
    case "stale": return repos.filter(r => daysSince(r.lastCommitDate) >= 30);
    case "error": return repos.filter(r => r.error);
    default: return repos;
  }
}

function renderRepos(repos) {
  allRepos = repos;
  renderFilters(repos);

  const filtered = filterRepos(repos);
  const dirty = repos.filter(r => r.uncommitted > 0).length;
  const needsPush = repos.filter(r => r.ahead > 0).length;
  const needsPull = repos.filter(r => r.behind > 0).length;
  const safePullable = repos.filter(r => r.behind > 0 && r.uncommitted === 0 && !r.error).length;
  const showFolder = new Set(repos.map(r => r.folder)).size > 1;

  document.getElementById("summary").textContent =
    repos.length + " repos | " + dirty + " uncommitted | " + needsPush + " to push | " + needsPull + " to pull";

  // Show/hide Pull All button
  const pullAllBtn = document.getElementById("pullAllBtn");
  if (safePullable > 0) {
    pullAllBtn.style.display = "";
    pullAllBtn.textContent = "⬇ Pull All Safe (" + safePullable + ")";
  } else {
    pullAllBtn.style.display = "none";
  }

  if (filtered.length === 0) {
    document.getElementById("content").innerHTML =
      '<div class="loading">No repos match this filter.</div>';
    return;
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  document.getElementById("content").innerHTML = '<div class="grid">' +
    filtered.map(repo => {
      const cls = getCardClass(repo);
      const path = esc(repo.path);
      const name = esc(repo.name);
      let badges = "";

      if (repo.error) {
        badges += '<span class="badge badge-error">Error</span>';
      } else {
        if (repo.uncommitted === 0 && repo.ahead === 0 && repo.behind === 0 && repo.hasRemote) {
          badges += '<span class="badge badge-clean">Clean</span>';
        }
        if (repo.uncommitted > 0) {
          badges += '<span class="badge badge-uncommitted">' + repo.uncommitted + ' uncommitted</span>';
        }
        if (repo.ahead > 0) {
          badges += '<span class="badge badge-ahead">' + repo.ahead + ' to push</span>';
        }
        if (repo.behind > 0) {
          badges += '<span class="badge badge-behind">' + repo.behind + ' to pull</span>';
        }
        if (!repo.hasRemote) {
          badges += '<span class="badge badge-no-remote">No remote</span>';
        }
        if (repo.detached) {
          badges += '<span class="badge badge-detached">Detached HEAD</span>';
        }
        const days = daysSince(repo.lastCommitDate);
        if (days >= 30) {
          badges += '<span class="badge badge-stale">Stale (' + days + 'd)</span>';
        }
      }

      const folderLabel = showFolder
        ? '<div class="folder-label">📁 ' + repo.folder.split('/').pop() + '</div>'
        : '';

      // Last commit line
      let lastCommitLine = '';
      if (repo.lastCommitDate) {
        const days = daysSince(repo.lastCommitDate);
        const ago = days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
        lastCommitLine = '<div class="last-commit">Last commit: ' + ago + '</div>';
      }

      // Action buttons
      let actions = '<button class="open-btn" data-path="' + path + '" onclick="openInVSCode(this.dataset.path)">Open in VS Code</button>' +
        '<button class="open-btn" data-path="' + path + '" onclick="revealInFinder(this.dataset.path)">Reveal in Finder</button>';

      if (repo.behind > 0) {
        actions += '<button class="action-btn pull-btn" data-path="' + path + '" onclick="pullRepo(this)">⬇ Pull</button>';
      }
      if (repo.ahead > 0) {
        actions += '<button class="action-btn push-btn" data-path="' + path + '" onclick="pushRepo(this)">⬆ Push</button>';
      }
      if (repo.uncommitted > 0 && aiAvailable) {
        actions += '<button class="action-btn ai-btn" data-path="' + path + '" data-name="' + name + '" onclick="generateCommitMsg(this)">🤖 AI Commit Msg</button>';
      }

      actions += '<button class="delete-btn" data-path="' + path + '" data-name="' + name + '" onclick="openDeleteModal(this.dataset.path, this.dataset.name)">Delete</button>';

      return '<div class="card ' + cls + '">' +
        folderLabel +
        '<div class="card-header">' +
          '<span class="repo-name">' + name + '</span>' +
          '<span class="branch">' + (repo.branch || "?") + '</span>' +
        '</div>' +
        '<div class="badges">' + badges + '</div>' +
        lastCommitLine +
        '<div class="card-actions">' + actions + '</div>' +
      '</div>';
    }).join("") +
  '</div>';
}

async function refresh() {
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  btn.textContent = "Scanning...";
  document.getElementById("content").innerHTML =
    '<div class="loading"><span class="spinner"></span>Scanning repositories...</div>';
  try {
    const repos = await fetchRepos();
    renderRepos(repos);
  } catch (e) {
    document.getElementById("content").innerHTML =
      '<div class="loading" style="color:#f85149">Failed to fetch: ' + e.message + '</div>';
  }
  btn.disabled = false;
  btn.textContent = "Refresh";
}

function showBanner(msg, type) {
  const el = document.getElementById("statusBanner");
  el.textContent = msg;
  el.className = "status-banner " + (type || "");
  el.style.display = "block";
}

function hideBanner() {
  document.getElementById("statusBanner").style.display = "none";
}

async function pullRepo(btn) {
  const path = btn.dataset.path;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Pulling...";
  try {
    const res = await fetch("/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.ok) {
      showBanner("Pull successful: " + (data.output || "Up to date"), "success");
      refresh();
    } else {
      showBanner("Pull failed: " + (data.error || "Unknown error"), "");
    }
  } catch (e) {
    showBanner("Pull failed: " + e.message, "");
  }
  btn.disabled = false;
  btn.textContent = orig;
}

async function pushRepo(btn) {
  const path = btn.dataset.path;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Pushing...";
  try {
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.ok) {
      showBanner("Push successful" + (data.output ? ": " + data.output : ""), "success");
      refresh();
    } else {
      showBanner("Push failed: " + (data.error || "Unknown error"), "");
    }
  } catch (e) {
    showBanner("Push failed: " + e.message, "");
  }
  btn.disabled = false;
  btn.textContent = orig;
}

async function pullAll() {
  const btn = document.getElementById("pullAllBtn");
  btn.disabled = true;
  btn.textContent = "⬇ Pulling...";
  showBanner("Pulling all safe repos...", "info");
  try {
    const res = await fetch("/api/pull-all", { method: "POST" });
    const data = await res.json();
    const ok = data.results.filter(r => r.ok).length;
    const fail = data.results.filter(r => !r.ok).length;
    let msg = "Pull All: " + ok + "/" + data.total + " succeeded";
    if (fail > 0) {
      msg += "\\n\\nFailed:\\n" + data.results.filter(r => !r.ok).map(r => "  " + r.repo + ": " + r.error).join("\\n");
      showBanner(msg, "warn");
    } else {
      showBanner(msg, "success");
    }
    refresh();
  } catch (e) {
    showBanner("Pull All failed: " + e.message, "");
  }
  btn.disabled = false;
}

async function generateCommitMsg(btn) {
  const path = btn.dataset.path;
  const name = btn.dataset.name;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "🤖 Generating...";
  try {
    const res = await fetch("/api/ai-commit-msg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("commitMsgRepo").textContent = name + " (" + path + ")";
      document.getElementById("commitMsgText").textContent = data.message;
      document.getElementById("copyCommitBtn").textContent = "📋 Copy to Clipboard";
      document.getElementById("commitMsgModal").classList.add("visible");
    } else {
      showBanner("AI Commit Msg failed: " + (data.error || "Unknown error"), "");
    }
  } catch (e) {
    showBanner("AI Commit Msg failed: " + e.message, "");
  }
  btn.disabled = false;
  btn.textContent = orig;
}

function closeCommitMsgModal() {
  document.getElementById("commitMsgModal").classList.remove("visible");
}

async function copyCommitMsg() {
  const text = document.getElementById("commitMsgText").textContent;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById("copyCommitBtn");
    btn.textContent = "✓ Copied!";
    setTimeout(() => { btn.textContent = "📋 Copy to Clipboard"; }, 2000);
  } catch {
    showBanner("Failed to copy — select the text manually", "");
  }
}

document.getElementById("commitMsgModal").addEventListener("click", function(e) {
  if (e.target === this) closeCommitMsgModal();
});

async function aiTriage() {
  const btn = document.getElementById("triageBtn");
  btn.disabled = true;
  btn.textContent = "🤖 Analyzing...";
  showBanner("Running AI triage analysis...", "info");
  try {
    const res = await fetch("/api/ai-triage", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showBanner(data.triage, "info");
    } else {
      showBanner("AI Triage failed: " + (data.error || "Unknown error"), "");
    }
  } catch (e) {
    showBanner("AI Triage failed: " + e.message, "");
  }
  btn.disabled = false;
  btn.textContent = "🤖 What needs attention?";
}

async function updateServer() {
  const btn = document.getElementById("updateBtn");
  btn.disabled = true;
  btn.textContent = "Pulling...";
  showBanner("Running git pull...", "info");
  try {
    const res = await fetch("/api/update", { method: "POST" });
    const data = await res.json();
    if (data.alreadyUpToDate) {
      showBanner("Already up to date.", "success");
    } else {
      showBanner("Update applied:\\n" + data.output + "\\n\\nClick 'Restart Server' to load the new version.", "warn");
    }
  } catch (e) {
    showBanner("Update failed: " + e.message, "");
  }
  btn.disabled = false;
  btn.textContent = "Check for Updates";
}

async function restartServer() {
  const btn = document.getElementById("restartBtn");
  btn.disabled = true;
  btn.textContent = "Restarting...";
  showBanner("Restarting server... page will reload automatically.", "info");
  try {
    await fetch("/api/restart", { method: "POST" });
  } catch { /* expected — server closes connection */ }
  // Poll until back up
  const start = Date.now();
  const poll = setInterval(async () => {
    if (Date.now() - start > 15000) {
      clearInterval(poll);
      showBanner("Server did not respond after 15s. Reload manually.", "");
      btn.disabled = false;
      btn.textContent = "Restart Server";
      return;
    }
    try {
      const r = await fetch("/api/config");
      if (r.ok) {
        clearInterval(poll);
        showBanner("Server restarted successfully.", "success");
        btn.disabled = false;
        btn.textContent = "Restart Server";
        refresh();
      }
    } catch { /* still restarting */ }
  }, 1000);
}

let autoRefreshTimer = null;

function setAutoRefresh(seconds, save = true) {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const sel = document.getElementById("autoRefreshSelect");
  sel.value = String(seconds);
  if (save) localStorage.setItem("autoRefreshInterval", String(seconds));
  if (seconds == 0) {
    sel.classList.remove("active");
    return;
  }
  sel.classList.add("active");
  autoRefreshTimer = setInterval(() => {
    if (!document.getElementById("refreshBtn").disabled) refresh();
  }, seconds * 1000);
}

let pendingDeletePath = null;

function openDeleteModal(path, name) {
  pendingDeletePath = path;
  document.getElementById("deleteModalPath").textContent = path;
  document.getElementById("deleteConfirmBtn").disabled = false;
  document.getElementById("deleteModal").classList.add("visible");
}

function closeDeleteModal() {
  pendingDeletePath = null;
  document.getElementById("deleteModal").classList.remove("visible");
}

async function confirmDelete() {
  if (!pendingDeletePath) return;
  const btn = document.getElementById("deleteConfirmBtn");
  btn.disabled = true;
  btn.textContent = "Deleting...";
  try {
    const res = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pendingDeletePath }),
    });
    const data = await res.json();
    closeDeleteModal();
    if (data.ok) {
      showBanner("Deleted: " + pendingDeletePath, "warn");
      refresh();
    } else {
      showBanner("Delete failed: " + (data.error || "Unknown error"), "");
    }
  } catch (e) {
    showBanner("Delete failed: " + e.message, "");
    closeDeleteModal();
  }
}

// Close modal on overlay click
document.getElementById("deleteModal").addEventListener("click", function(e) {
  if (e.target === this) closeDeleteModal();
});

const savedInterval = localStorage.getItem("autoRefreshInterval");
if (savedInterval && savedInterval !== "0") setAutoRefresh(Number(savedInterval), false);

refresh();
</script>
</body>
</html>`;
}

async function main() {
  const config = await loadConfig();
  AI_AVAILABLE = await checkAIAvailable();
  log(`AI available: ${AI_AVAILABLE}${AI_AVAILABLE ? ` (${INFERENCE_PATH})` : ""}`);
  const cachedHTML = renderHTML();

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      log(`→ ${req.method} ${url.pathname}`);

      if (url.pathname === "/api/open" && req.method === "POST") {
        const body = await req.json();
        const v = validateRepoPath(body.path, config);
        if ("error" in v) return Response.json({ error: v.error }, { status: v.status });
        const proc = Bun.spawn(["code", v.resolved], { stdout: "ignore", stderr: "ignore" });
        await proc.exited;
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/reveal" && req.method === "POST") {
        const body = await req.json();
        const v = validateRepoPath(body.path, config);
        if ("error" in v) return Response.json({ error: v.error }, { status: v.status });
        const cmd = process.platform === "win32"
          ? ["explorer", `/select,${v.resolved}`]
          : ["open", "-R", v.resolved];
        const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
        await proc.exited;
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/pull" && req.method === "POST") {
        const body = await req.json();
        const v = validateRepoPath(body.path, config);
        if ("error" in v) return Response.json({ error: v.error }, { status: v.status });
        try {
          const output = await runGit(v.resolved, ["pull"]);
          log(`Pull ${v.resolved}: ${output}`);
          return Response.json({ ok: true, output });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/push" && req.method === "POST") {
        const body = await req.json();
        const v = validateRepoPath(body.path, config);
        if ("error" in v) return Response.json({ error: v.error }, { status: v.status });
        try {
          const output = await runGit(v.resolved, ["push"]);
          log(`Push ${v.resolved}: ${output}`);
          return Response.json({ ok: true, output });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/pull-all" && req.method === "POST") {
        log("Pull-all requested — scanning for safe repos...");
        const repos = await getGitRepos(config);
        const statuses = await pMap(repos, (r, i) => getRepoStatus(r, i, repos.length), 8);
        const pullable = statuses.filter(s => s.behind > 0 && s.uncommitted === 0 && !s.error);
        log(`Pull-all: ${pullable.length} repos eligible`);
        const results = await pMap(pullable, async (s) => {
          try {
            const output = await runGit(s.path, ["pull"]);
            log(`  Pull-all ${s.name}: ${output}`);
            return { repo: s.name, ok: true, output };
          } catch (e: any) {
            return { repo: s.name, ok: false, error: e.message };
          }
        }, 4);
        return Response.json({ results, total: pullable.length });
      }

      if (url.pathname === "/api/ai-commit-msg" && req.method === "POST") {
        if (!AI_AVAILABLE) {
          return Response.json({ error: "AI not available (Inference.ts not found)" }, { status: 503 });
        }
        const body = await req.json();
        const v = validateRepoPath(body.path, config);
        if ("error" in v) return Response.json({ error: v.error }, { status: v.status });
        try {
          const staged = await runGit(v.resolved, ["diff", "--staged"]);
          const diff = staged || await runGit(v.resolved, ["diff", "HEAD"]);
          if (!diff) {
            return Response.json({ error: "No changes to generate message for" }, { status: 400 });
          }
          const maxLen = 8000;
          const truncated = diff.length > maxLen
            ? diff.slice(0, maxLen) + "\n\n... [diff truncated]"
            : diff;
          const systemPrompt = "You are a git commit message generator. Output ONLY the commit message, nothing else. Use conventional commit format (feat:, fix:, refactor:, docs:, chore:, etc). First line max 72 chars. Add body paragraph if the change is non-trivial.";
          const userPrompt = "Generate a commit message for this diff:\n\n" + truncated;
          const message = await runInference(systemPrompt, userPrompt);
          return Response.json({ ok: true, message });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/ai-triage" && req.method === "POST") {
        if (!AI_AVAILABLE) {
          return Response.json({ error: "AI not available (Inference.ts not found)" }, { status: 503 });
        }
        try {
          const repos = await getGitRepos(config);
          const statuses = await pMap(repos, (r, i) => getRepoStatus(r, i, repos.length), 8);
          const actionable = statuses.filter(s =>
            s.uncommitted > 0 || s.ahead > 0 || s.behind > 0 || s.error || !s.hasRemote
          );
          if (actionable.length === 0) {
            return Response.json({ ok: true, triage: "✅ All repos are clean — nothing needs attention!", repoCount: 0 });
          }
          const summary = JSON.stringify(actionable.map(s => ({
            name: s.name, branch: s.branch, uncommitted: s.uncommitted,
            ahead: s.ahead, behind: s.behind, hasRemote: s.hasRemote,
            error: s.error, lastCommitDate: s.lastCommitDate,
          })));
          const systemPrompt = "You are a git repository triage assistant. Given a JSON array of repos needing attention, output a SHORT prioritized action list. Group by urgency. Use emoji prefixes: 🔴 urgent (errors, conflicts), 🟡 action needed (uncommitted changes, push/pull), 🔵 informational (no remote, stale). Be concise — one line per repo.";
          const userPrompt = "Triage these repos:\n" + summary;
          const triage = await runInference(systemPrompt, userPrompt);
          return Response.json({ ok: true, triage, repoCount: actionable.length });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/repos" && req.method === "GET") {
        const t0 = performance.now();
        log(`Scan requested. Dirs: ${config.projectDirs.join(", ")}`);
        const repos = await getGitRepos(config);
        log(`Fetching status for ${repos.length} repos (concurrency: 8)...`);
        const statuses = await pMap(
          repos,
          (repo, i) => getRepoStatus(repo, i, repos.length),
          8,
        );
        log(`Scan complete in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        return Response.json(statuses);
      }

      if (url.pathname === "/api/config") {
        return Response.json({ projectDirs: config.projectDirs, aiAvailable: AI_AVAILABLE });
      }

      if (url.pathname === "/api/update" && req.method === "POST") {
        const serverDir = import.meta.dir;
        const proc = Bun.spawn(["git", "pull"], {
          cwd: serverDir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        const output = (stdout + stderr).trim();
        const alreadyUpToDate = output.includes("Already up to date");
        log(`Update check: ${output}`);
        return Response.json({ ok: true, output, alreadyUpToDate });
      }

      if (url.pathname === "/api/delete" && req.method === "POST") {
        const body = await req.json();
        const v = validateRepoPath(body.path, config);
        if ("error" in v) return Response.json({ error: v.error }, { status: v.status });
        // Must be a git repo
        const gitDir = join(v.resolved, ".git");
        try {
          await stat(gitDir);
        } catch {
          return Response.json({ error: "Not a git repository" }, { status: 400 });
        }
        const proc = Bun.spawn(["rm", "-rf", v.resolved], { stdout: "ignore", stderr: "pipe" });
        const errText = await new Response(proc.stderr).text();
        await proc.exited;
        if (errText.trim()) {
          log(`Delete error for ${v.resolved}: ${errText}`);
          return Response.json({ error: errText.trim() }, { status: 500 });
        }
        log(`Deleted repo: ${v.resolved}`);
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/restart" && req.method === "POST") {
        log("Restart requested via UI — exiting for launchd restart");
        setTimeout(() => process.exit(0), 300);
        return Response.json({ ok: true, message: "Restarting..." });
      }

      if (url.pathname === "/favicon.jpg" || url.pathname === "/favicon.ico") {
        try {
          const img = await readFile(join(import.meta.dir, "favicon.jpg"));
          return new Response(img, { headers: { "Content-Type": "image/jpeg" } });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      if (url.pathname === "/") {
        return new Response(cachedHTML, {
          headers: { "Content-Type": "text/html", "Connection": "close" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  log(`Git Status Dashboard running at http://localhost:${PORT}${DEBUG ? "  [DEBUG MODE]" : ""}`);
  log(`Watching: ${config.projectDirs.join(", ")}`);
}

main();
