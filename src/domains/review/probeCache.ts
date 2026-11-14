import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * review_probe_cache
 *
 * Diagnostic MCP tool. Walks InDesign's user-data tree looking for places
 * where Share-for-Review comment data might be cached on disk (the UXP
 * WebView's LevelDB Local Storage, IndexedDB, Edge WebView2 disk cache, the
 * comments-webview plugin's PluginData folder). Reports what exists, file
 * sizes, and modification times. Reads nothing beyond that — no parsing of
 * binary caches, no network.
 *
 * Why this exists: ADR-0001 chose Vision + UI Automation as the primary
 * review-reading path because a Phase-1 probe found the cache effectively
 * empty for this user. This tool is kept as a cheap ongoing re-check: if a
 * future InDesign release starts persisting comment data, this will catch
 * it and we can switch back to the structured path.
 */

type Candidate = {
  label: string;
  relative: string;
  kind: "dir" | "file";
  hint: string;
};

const CANDIDATES: Candidate[] = [
  {
    label: "comments-webview plugin storage",
    relative: "UXP/PluginsStorage/Internal/com.adobe.ccx.comments-webview",
    kind: "dir",
    hint: "If populated, the comments panel UXP plugin keeps per-review state here.",
  },
  {
    label: "WebView Local Storage (LevelDB)",
    relative: "UXP/WebView/EBWebView/Default/Local Storage/leveldb",
    kind: "dir",
    hint: "Chromium Local Storage. JS running in the comments webview may persist state here.",
  },
  {
    label: "WebView Session Storage",
    relative: "UXP/WebView/EBWebView/Default/Session Storage",
    kind: "dir",
    hint: "Chromium Session Storage. Usually ephemeral per-tab.",
  },
  {
    label: "WebView IndexedDB",
    relative: "UXP/WebView/EBWebView/Default/IndexedDB",
    kind: "dir",
    hint: "Primary structured store for a PWA/WebView app. Highest-value target if present.",
  },
  {
    label: "WebView disk cache",
    relative: "UXP/WebView/EBWebView/Default/Cache",
    kind: "dir",
    hint: "Chromium HTTP cache. May hold Adobe review API response bodies.",
  },
  {
    label: "WebView cookies",
    relative: "UXP/WebView/EBWebView/Default/Network/Cookies",
    kind: "file",
    hint: "If present, contains the auth cookies the webview uses against Adobe's cloud.",
  },
];

export interface ProbeHit {
  label: string;
  path: string;
  kind: "dir" | "file";
  exists: boolean;
  bytes?: number;
  entries?: number;
  modifiedAt?: string;
  hint: string;
}

async function totalSize(dir: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  async function walk(d: string): Promise<void> {
    let items: import("node:fs").Dirent[];
    try {
      items = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.isFile()) {
        entries += 1;
        try {
          const st = await fs.stat(p);
          bytes += st.size;
        } catch {
          /* unreadable */
        }
      }
    }
  }
  await walk(dir);
  return { bytes, entries };
}

async function inspect(root: string, c: Candidate): Promise<ProbeHit> {
  const abs = path.join(root, c.relative);
  const hit: ProbeHit = {
    label: c.label,
    path: abs,
    kind: c.kind,
    exists: false,
    hint: c.hint,
  };
  try {
    const st = await fs.stat(abs);
    hit.exists = true;
    hit.modifiedAt = st.mtime.toISOString();
    if (c.kind === "file") {
      hit.bytes = st.size;
    } else {
      const { bytes, entries } = await totalSize(abs);
      hit.bytes = bytes;
      hit.entries = entries;
    }
  } catch {
    /* missing */
  }
  return hit;
}

function defaultRoots(): string[] {
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  // InDesign 2027 = Version 22.0; include 21.0 for bridging older installs.
  return [
    path.join(roaming, "Adobe", "InDesign", "Version 22.0", "en_US"),
    path.join(roaming, "Adobe", "InDesign", "Version 21.0", "en_US"),
  ];
}

export function registerReviewProbeTools() {
  return {
    review_probe_cache: {
      description:
        "Scan InDesign's user-data tree for places Share-for-Review comment data might be cached on disk (comments-webview plugin storage, WebView LevelDB/IndexedDB/Cache, cookies). Reports which exist, sizes, modification times. Read-only; does not parse binary caches.",
      inputSchema: {
        type: "object" as const,
        properties: {
          roots: {
            type: "array",
            items: { type: "string" },
            description:
              "Override root paths to scan. Defaults to InDesign 22.0 (2027) and 21.0 (2026) user-data dirs under %APPDATA%\\Adobe\\InDesign.",
          },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const rootsIn = Array.isArray(args.roots) ? (args.roots as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
        const roots = rootsIn.length > 0 ? rootsIn : defaultRoots();
        const perRoot = await Promise.all(
          roots.map(async (root) => {
            let rootExists = false;
            try {
              await fs.access(root);
              rootExists = true;
            } catch {
              /* missing */
            }
            const hits = rootExists ? await Promise.all(CANDIDATES.map((c) => inspect(root, c))) : [];
            return { root, exists: rootExists, hits };
          }),
        );

        const populated = perRoot.flatMap((r) => r.hits.filter((h) => h.exists && (h.bytes ?? 0) > 0));
        const emptyButPresent = perRoot.flatMap((r) => r.hits.filter((h) => h.exists && !(h.bytes && h.bytes > 0)));
        const verdict =
          populated.length === 0
            ? "no_populated_cache"
            : populated.some((h) => h.label.includes("IndexedDB") || h.label.includes("comments-webview"))
              ? "structured_cache_candidate"
              : "ambient_webview_cache_only";

        return {
          verdict,
          summary:
            verdict === "no_populated_cache"
              ? "No review-comment cache found. Vision + UI Automation path remains primary (see ADR-0001)."
              : verdict === "structured_cache_candidate"
                ? "A candidate structured store exists. Worth a deeper spike before Phase 1 locks in the vision path."
                : "Only ambient Chromium WebView caches. Unlikely to hold parseable comment data; vision path remains primary.",
          perRoot,
          populated,
          emptyButPresent,
          note:
            "This tool only reports metadata. It never opens a database or parses a binary cache; doing so safely would need its own tool with explicit approval.",
        };
      },
    },
  };
}
