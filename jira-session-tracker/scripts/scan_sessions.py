#!/usr/bin/env python3
"""Reads Claude Code's local session transcripts and prints one compact JSON
record per session that has activity at or after SINCE_MS.

usage: scan_sessions.py <projects_dir> <cache_file> <since_ms> <idle_ms>

Each record: id, cwd, title, segs ([start_ms, end_ms, branch] runs of activity,
split where a gap exceeds idle_ms or the branch changes), prompts ([ms, text],
human prompts only, cleaned), files ([ms, path] edited or written), keys
(ticket keys seen in prompts), human (count of human prompts), entry
(the entrypoint: cli, claude-desktop, sdk-cli for a headless run).

Results are cached per file by (size, mtime, idle_ms), so a refresh re-reads
only transcripts that changed. Only top-level <project>/<session>.jsonl files
are read: subagent transcripts sit in sub-folders and are skipped.
"""
import json
import os
import re
import sys
from datetime import datetime

KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,14}-\d{1,6})\b")
NOISE = [
    re.compile(r"<pasted_content[^>]*>.*?</pasted_content>", re.S),
    re.compile(r"<system-reminder>.*?</system-reminder>", re.S),
    re.compile(r"<local-command-[a-z]+>.*?</local-command-[a-z]+>", re.S),
    re.compile(r"<command-[a-z]+>.*?</command-[a-z]+>", re.S),
    re.compile(r"\[Image #\d+\]"),
    re.compile(r"\[Pasted text[^\]]*\]"),
    re.compile(r"<[^>]{1,60}>"),
]
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
TAIL_MS = 60_000  # a message implies about a minute of work after it


def parse_ts(value):
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def clean(text):
    for rx in NOISE:
        text = rx.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:220]


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                out.append(str(block.get("text", "")))
        return " ".join(out)
    return ""


def scan_file(path, idle_ms):
    sid = os.path.basename(path)[:-6]
    cwd = ""
    title = ""
    events = []  # (ms, branch)
    prompts = []
    files = []
    keys = set()
    human = 0
    entry = ""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"timestamp"' not in line and '"ai-title"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            kind = row.get("type")
            if kind == "ai-title":
                title = str(row.get("aiTitle") or title)
                continue
            if kind not in ("user", "assistant") or row.get("isSidechain"):
                continue
            ms = parse_ts(row.get("timestamp"))
            if ms is None:
                continue
            cwd = row.get("cwd") or cwd
            entry = entry or str(row.get("entrypoint") or "")
            branch = row.get("gitBranch") or ""
            events.append((ms, branch))
            msg = row.get("message") or {}
            if kind == "user":
                origin = row.get("origin") or {}
                is_human = origin.get("kind") == "human" or row.get("promptSource") == "typed"
                if is_human and not row.get("isMeta"):
                    raw = text_of(msg.get("content"))
                    if raw and not raw.startswith("<local-command") and not raw.startswith("<command-name>"):
                        human += 1
                        for k in KEY_RE.findall(raw):
                            keys.add(k)
                        if len(prompts) < 12:
                            txt = clean(raw)
                            if txt:
                                prompts.append([ms, txt])
            else:
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") in EDIT_TOOLS:
                            fp = (block.get("input") or {}).get("file_path") or (block.get("input") or {}).get("notebook_path")
                            if fp and len(files) < 400:
                                files.append([ms, str(fp)])
    events.sort()
    segs = []
    for ms, branch in events:
        if segs and ms - segs[-1][1] <= idle_ms and (branch == segs[-1][2] or not branch):
            segs[-1][1] = max(segs[-1][1], ms + TAIL_MS)
        elif segs and ms - segs[-1][1] <= idle_ms:
            # branch changed inside an active run: close the run here, open a new one
            segs.append([segs[-1][1], ms + TAIL_MS, branch])
        else:
            segs.append([ms, ms + TAIL_MS, branch])
    for k in KEY_RE.findall(" ".join(s[2] for s in segs)):
        keys.add(k)
    return {
        "id": sid,
        "cwd": cwd,
        "title": clean(title)[:90],
        "segs": segs,
        "prompts": prompts,
        "files": files,
        "keys": sorted(keys),
        "human": human,
        "entry": entry,
    }


def main():
    projects, cache_path, since_ms, idle_ms = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    try:
        with open(cache_path, "r", encoding="utf-8") as fh:
            cache = json.load(fh)
    except (OSError, ValueError):
        cache = {}
    out = []
    fresh = {}
    for folder in sorted(os.listdir(projects)) if os.path.isdir(projects) else []:
        full = os.path.join(projects, folder)
        if not os.path.isdir(full):
            continue
        for name in os.listdir(full):
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(full, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_mtime * 1000 < since_ms:
                continue
            sig = f"{st.st_size}:{int(st.st_mtime)}:{idle_ms}"
            hit = cache.get(path)
            if hit and hit.get("sig") == sig:
                rec = hit["rec"]
            else:
                try:
                    rec = scan_file(path, idle_ms)
                except OSError:
                    continue
            fresh[path] = {"sig": sig, "rec": rec}
            if rec["segs"] and rec["segs"][-1][1] >= since_ms:
                out.append(rec)
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp = cache_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(fresh, fh)
        os.replace(tmp, cache_path)
    except OSError:
        pass
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
