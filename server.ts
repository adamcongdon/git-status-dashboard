import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const PROJECTS_DIR = join(homedir(), "code");
const PORT = 3847;

async function getGitRepos(): Promise<string[]> {
  const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "git-status-dashboard") continue;
    const gitDir = join(PROJECTS_DIR, entry.name, ".git");
    try {
      const s = await stat(gitDir);
      if (s.isDirectory()) repos.push(entry.name);
    } catch {
      // not a git repo
    }
  }
  return repos.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

interface RepoStatus {
  name: string;
  branch: string;
  uncommitted: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  detached: boolean;
  error?: string;
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

async function getRepoStatus(name: string): Promise<RepoStatus> {
  const repoPath = join(PROJECTS_DIR, name);
  const status: RepoStatus = {
    name,
    branch: "",
    uncommitted: 0,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    detached: false,
  };

  try {
    // Run independent git commands in parallel
    const [branch, porcelain, remotes] = await Promise.all([
      runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(repoPath, ["status", "--porcelain"]),
      runGit(repoPath, ["remote"]),
    ]);

    status.branch = branch;
    if (branch === "HEAD") {
      status.detached = true;
    }
    status.uncommitted = porcelain ? porcelain.split("\n").length : 0;
    status.hasRemote = remotes.length > 0;

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

  return status;
}

function renderHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Git Status Dashboard</title>
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
  .card-actions { margin-top: 10px; }
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
</style>
</head>
<body>
<header>
  <h1>Git Status Dashboard</h1>
  <div class="header-right">
    <span class="summary" id="summary"></span>
    <button onclick="refresh()" id="refreshBtn">Refresh</button>
  </div>
</header>
<div class="filter-bar" id="filters"></div>
<div id="content"><div class="loading"><span class="spinner"></span>Scanning repositories...</div></div>
<script>
let allRepos = [];
let activeFilter = "all";

async function openInVSCode(name) {
  await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

async function fetchRepos() {
  const res = await fetch("/api/repos");
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

  const filters = [
    { id: "all", label: "All", count: repos.length },
    { id: "dirty", label: "Uncommitted", count: dirty },
    { id: "pending", label: "Ahead/Behind", count: pending },
    { id: "clean", label: "Clean", count: clean },
    { id: "no-remote", label: "No Remote", count: noRemote },
  ];
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

  document.getElementById("summary").textContent =
    repos.length + " repos | " + dirty + " uncommitted | " + needsPush + " to push | " + needsPull + " to pull";

  if (filtered.length === 0) {
    document.getElementById("content").innerHTML =
      '<div class="loading">No repos match this filter.</div>';
    return;
  }

  document.getElementById("content").innerHTML = '<div class="grid">' +
    filtered.map(repo => {
      const cls = getCardClass(repo);
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
      }

      return '<div class="card ' + cls + '">' +
        '<div class="card-header">' +
          '<span class="repo-name">' + repo.name + '</span>' +
          '<span class="branch">' + (repo.branch || "?") + '</span>' +
        '</div>' +
        '<div class="badges">' + badges + '</div>' +
        '<div class="card-actions">' +
          '<button class="open-btn" onclick="openInVSCode(\\'' + repo.name + '\\')">Open in VS Code</button>' +
        '</div>' +
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

refresh();
</script>
</body>
</html>`;
}

const cachedHTML = renderHTML();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/open" && req.method === "POST") {
      const body = await req.json();
      const name = body.name;
      if (!name || name.includes("..") || name.includes("/")) {
        return Response.json({ error: "Invalid repo name" }, { status: 400 });
      }
      const repoPath = join(PROJECTS_DIR, name);
      const proc = Bun.spawn(["code", repoPath], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/repos") {
      const repos = await getGitRepos();
      const statuses = await Promise.all(repos.map(getRepoStatus));
      return Response.json(statuses);
    }

    if (url.pathname === "/") {
      return new Response(cachedHTML, {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Git Status Dashboard running at http://localhost:${PORT}`);
