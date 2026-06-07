#!/usr/bin/env python3
"""
semantic-revert-check.py

Detects potential semantic reverts in a PR by checking whether lines
deleted by the PR were added in recently-merged commits on main.

Usage (GitHub Actions):
  Set env vars GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH,
  then run without arguments.

Usage (local):
  python semantic-revert-check.py --pr 255 --repo owner/repo --lookback 7

Comment deduplication:
  Each comment includes a hidden HTML marker. On re-runs the script
  finds the existing comment and edits it (or deletes + re-posts if
  the findings changed), so pushes don't spam the PR.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MARKER = "<!-- semantic-revert-check -->"
DEFAULT_LOOKBACK_DAYS = 7
DEFAULT_BASE_BRANCH = "main"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def git(*args: str) -> str:
    """Run a git command and return stdout."""
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed:\n{result.stderr}")
    return result.stdout


def get_token() -> str:
    """Get a GitHub token: from env, or via gh CLI."""
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        return token
    try:
        result = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


def gh_api(url: str, token: str, method: str = "GET", data: dict | None = None) -> dict | list:
    """Call the GitHub REST API and return parsed JSON."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body = json.dumps(data).encode() if data else None
    req = Request(url, data=body, headers=headers, method=method)
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as exc:
        if exc.code == 404:
            return {}
        raise


def parse_patch_deletions(patch: str) -> dict[int, list[str]]:
    """
    Parse a unified diff patch and return {line_number: [line_content]}
    for lines starting with '-' (deleted lines).

    Line numbers are 1-indexed in the *old* file, which is what git
    blame will compare against.
    """
    deleted: dict[int, list[str]] = {}  # file_line -> [content]
    # hunk header: @@ -old_start[,old_count] +new_start[,new_count] @@
    hunk_re = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@")
    current_hunk_old_start = None
    old_line = None
    for line in patch.splitlines():
        m = hunk_re.match(line)
        if m:
            current_hunk_old_start = int(m.group(1))
            old_line = current_hunk_old_start
            continue
        if old_line is None:
            continue
        if line.startswith("-"):
            content = line[1:]  # strip the leading -
            deleted.setdefault(old_line, []).append(content)
            old_line += 1
        elif line.startswith("+"):
            # added line — doesn't advance old line counter
            pass
        else:
            # context line
            old_line += 1
    return deleted


def parse_patch_additions(patch: str) -> list[str]:
    """
    Return a list of lines that were *added* in a commit's patch
    (lines starting with '+', content only).
    """
    added: list[str] = []
    for line in patch.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
    return added


def lines_overlap(deleted_lines: dict[int, list[str]], added_lines: list[str]) -> list[str]:
    """
    Check if any of the deleted lines (content strings) appear in the
    added lines. Returns matching content strings.
    """
    deleted_content = set()
    for contents in deleted_lines.values():
        deleted_content.update(c.strip() for c in contents)
    added_content = set(c.strip() for c in added_lines)
    overlap = deleted_content & added_content
    # Filter out trivial overlaps (empty lines, single braces, etc.)
    trivial = {"", "{", "}", "(", ")", ";", "//", "/*", "*/"}
    overlap -= trivial
    return sorted(overlap)


def get_pr_info_from_event(event_path: str) -> tuple[int, str, str]:
    """Extract PR number, owner/repo, and base ref from GitHub Actions event JSON."""
    with open(event_path) as f:
        event = json.load(f)
    pr = event["pull_request"]
    number = pr["number"]
    repo = pr["base"]["repo"]["full_name"]
    base = pr["base"]["ref"]
    return number, repo, base


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def find_semantic_reverts(
    pr_number: int,
    repo: str,
    base_branch: str = DEFAULT_BASE_BRANCH,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    token: str = "",
) -> list[dict]:
    """
    Check if the PR deletes lines that were recently added on main.

    Returns a list of dicts:
    [
      {
        "file": "path/to/file.ts",
        "overlap_lines": ["Sentry.captureMessage(...)", ...],
        "source_commits": [
          {"sha": "abc1234", "pr_number": 255, "title": "feat: ...", "merged_at": "2026-06-07"},
        ]
      },
      ...
    ]
    """
    api_base = f"https://api.github.com/repos/{repo}"

    # 1. Get the PR's diff files
    pr_files = gh_api(f"{api_base}/pulls/{pr_number}/files", token)

    # 2. Get recent merges to base_branch
    since = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()
    # Use git log locally since we have full history
    log_output = git(
        "log", base_branch,
        f"--since={lookback_days} days ago",
        "--merges",          # only merge commits
        "--format=%H %s",   # sha + subject
        "--",
    )

    recent_merge_shas: list[tuple[str, str]] = []
    if log_output.strip():
        for line in log_output.strip().splitlines():
            parts = line.split(" ", 1)
            if len(parts) == 2:
                recent_merge_shas.append((parts[0], parts[1]))

    # Also include non-merge commits (squash-merged PRs show as regular commits)
    log_output_squash = git(
        "log", base_branch,
        f"--since={lookback_days} days ago",
        "--no-merges",
        "--format=%H %s",
    )
    if log_output_squash.strip():
        for line in log_output_squash.strip().splitlines():
            parts = line.split(" ", 1)
            if len(parts) == 2:
                recent_merge_shas.append((parts[0], parts[1]))

    # Deduplicate by SHA
    seen_shas = set()
    unique_merges = []
    for sha, subject in recent_merge_shas:
        if sha not in seen_shas:
            seen_shas.add(sha)
            unique_merges.append((sha, subject))

    # Build a map of file -> [(sha, subject, added_lines)]
    # For each file touched by the PR that has deletions, check recent commits
    findings: list[dict] = []

    for pr_file in pr_files:
        patch = pr_file.get("patch", "")
        deletions = pr_file.get("deletions", 0) or 0
        filepath = pr_file.get("filename", "")

        if deletions == 0 or not patch:
            continue

        # Parse the PR's deletions from the patch
        pr_deleted_lines = parse_patch_deletions(patch)
        if not pr_deleted_lines:
            continue

        # Check each recent commit to see if it added lines that the PR deletes
        source_commits = []
        for sha, subject in unique_merges:
            try:
                commit_diff = git("show", sha, "--", filepath)
            except RuntimeError:
                continue
            if not commit_diff.strip():
                continue

            added_in_commit = parse_patch_additions(commit_diff)
            if not added_in_commit:
                continue

            overlap = lines_overlap(pr_deleted_lines, added_in_commit)
            if overlap:
                # Try to extract PR number from subject like "#255)" or "(#255)"
                pr_num = None
                pr_match = re.search(r"#(\d+)", subject)
                if pr_match:
                    pr_num = int(pr_match.group(1))

                # Get merge date
                try:
                    date_str = git("log", "-1", "--format=%cs", sha).strip()
                except RuntimeError:
                    date_str = "unknown"

                source_commits.append({
                    "sha": sha[:7],
                    "pr_number": pr_num,
                    "title": subject,
                    "merged_at": date_str,
                    "overlap_lines": overlap,
                })

        if source_commits:
            # Deduplicate overlap_lines across all source commits for this file
            all_overlap: set[str] = set()
            for sc in source_commits:
                all_overlap.update(sc["overlap_lines"])

            findings.append({
                "file": filepath,
                "overlap_lines": sorted(all_overlap),
                "source_commits": source_commits,
            })

    return findings


def format_comment(findings: list[dict], pr_number: int) -> str:
    """Format findings into a Markdown comment with hidden marker."""
    lines = [MARKER]
    lines.append(f"⚠️ **Potential semantic revert detected**")
    lines.append("")

    for finding in findings:
        total_lines = len(finding["overlap_lines"])
        lines.append(f"This PR deletes {total_lines} line(s) from `{finding['file']}` that were added in:")
        lines.append("")
        for sc in finding["source_commits"]:
            pr_ref = f"#{sc['pr_number']}" if sc["pr_number"] else sc["sha"]
            lines.append(f"- {pr_ref} (merged {sc['merged_at']}) — \"{sc['title']}\"")
        lines.append("")

    lines.append(
        "If this is an intentional cleanup, ignore this warning. "
        "If not, this PR's branch may be based on a pre-merge commit and could revert recently-shipped work. "
        "Consider rebasing onto main."
    )
    return "\n".join(lines)


def post_or_update_comment(
    repo: str,
    pr_number: int,
    body: str,
    token: str,
) -> None:
    """
    Post a comment or update the existing one (idempotent).
    Uses marker-based deduplication.
    """
    api_base = f"https://api.github.com/repos/{repo}"

    # Check for existing comment with our marker
    page = 1
    existing_comment_id = None
    existing_comment_body = None
    while page <= 10:  # safety limit
        comments = gh_api(
            f"{api_base}/issues/{pr_number}/comments?per_page=100&page={page}",
            token,
        )
        if not comments:
            break
        for comment in comments:
            if MARKER in comment.get("body", ""):
                existing_comment_id = comment["id"]
                existing_comment_body = comment["body"]
                break
        if existing_comment_id:
            break
        page += 1

    if existing_comment_id and existing_comment_body == body:
        # No change — skip
        print("Existing comment is up-to-date. No update needed.")
        return

    if existing_comment_id:
        # Update existing comment
        gh_api(
            f"{api_base}/issues/comments/{existing_comment_id}",
            token,
            method="PATCH",
            data={"body": body},
        )
        print(f"Updated existing comment (id={existing_comment_id}).")
    else:
        # Post new comment
        gh_api(
            f"{api_base}/issues/{pr_number}/comments",
            token,
            method="POST",
            data={"body": body},
        )
        print(f"Posted new comment on PR #{pr_number}.")


def delete_comment(repo: str, comment_id: int, token: str) -> None:
    """Delete a comment by ID."""
    gh_api(
        f"https://api.github.com/repos/{repo}/issues/comments/{comment_id}",
        token,
        method="DELETE",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    dry_run = False

    # Determine inputs
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # Running in GitHub Actions
        event_path = os.environ["GITHUB_EVENT_PATH"]
        pr_number, repo, base_branch = get_pr_info_from_event(event_path)
        token = get_token()
        lookback_days = DEFAULT_LOOKBACK_DAYS
    else:
        # Local / manual run
        import argparse
        parser = argparse.ArgumentParser(description="Check for semantic reverts in a PR")
        parser.add_argument("--pr", type=int, required=True, help="PR number")
        parser.add_argument("--repo", required=True, help="Owner/repo (e.g. owner/repo)")
        parser.add_argument("--base", default=DEFAULT_BASE_BRANCH, help="Base branch")
        parser.add_argument("--lookback", type=int, default=DEFAULT_LOOKBACK_DAYS, help="Lookback days")
        parser.add_argument("--dry-run", action="store_true", help="Print findings but don't post comment")
        parser.add_argument("--token", default="", help="GitHub token (or set GITHUB_TOKEN)")
        args = parser.parse_args()

        pr_number = args.pr
        repo = args.repo
        base_branch = args.base
        lookback_days = args.lookback
        token = args.token or get_token()
        dry_run = args.dry_run

    lookback_days = int(os.environ.get("LOOKBACK_DAYS", lookback_days))

    print(f"Checking PR #{pr_number} in {repo} for semantic reverts (lookback: {lookback_days} days)...")

    findings = find_semantic_reverts(
        pr_number=pr_number,
        repo=repo,
        base_branch=base_branch,
        lookback_days=lookback_days,
        token=token,
    )

    if not findings:
        print("No semantic reverts detected.")

        # Clean up any existing comment from a previous run
        if token and not dry_run:
            api_base = f"https://api.github.com/repos/{repo}"
            page = 1
            while page <= 10:
                comments = gh_api(
                    f"{api_base}/issues/{pr_number}/comments?per_page=100&page={page}",
                    token,
                )
                if not comments:
                    break
                for comment in comments:
                    if MARKER in comment.get("body", ""):
                        print(f"Removing stale comment (id={comment['id']}).")
                        delete_comment(repo, comment["id"], token)
                        break
                page += 1
        return

    print(f"Found {len(findings)} potential semantic revert(s):")
    for f in findings:
        print(f"  - {f['file']}: {len(f['overlap_lines'])} overlapping line(s)")
        for sc in f["source_commits"]:
            print(f"    from {sc['sha']} (#{sc['pr_number']}): {sc['title']}")

    body = format_comment(findings, pr_number)
    print("\n--- Comment body ---")
    print(body)
    print("--- End comment ---\n")

    if not dry_run:
        if token:
            post_or_update_comment(repo, pr_number, body, token)
        else:
            print("No GitHub token available; skipping comment post.")


if __name__ == "__main__":
    main()