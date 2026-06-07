#!/usr/bin/env python3
"""
semantic-revert-check.py

Detects potential semantic reverts in a PR by checking whether lines
that exist on main would be removed if the PR were merged.

The key insight: GitHub's PR diff (three-dot) only shows what the PR
branch *adds* relative to the merge base. But a stale-based PR can
silently revert code. We detect this by checking git diff main..PR_HEAD
for lines removed from main that were recently added.

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
            body = resp.read().decode()
            if not body:
                return {}
            return json.loads(body)
    except HTTPError as exc:
        if exc.code in (204, 404):
            return {}
        raise


def parse_diff_deletions(diff_text: str) -> dict[str, list[tuple[int, str]]]:
    """
    Parse a unified diff and return {filepath: [(old_line_num, line_content)]}
    for every line starting with '-' (deletions from the old side).

    Line numbers are 1-indexed in the *old* file.
    """
    result: dict[str, list[tuple[int, str]]] = {}
    current_file = None
    old_line = None

    for line in diff_text.splitlines():
        # File header: --- a/path/to/file
        if line.startswith("--- a/"):
            current_file = line[6:]
            old_line = None
            continue
        if line.startswith("+++ b/"):
            continue
        # New file or binary
        if line.startswith("--- /dev/null") or line.startswith("Binary files"):
            current_file = None
            continue
        # Hunk header: @@ -old_start[,old_count] +new_start[,new_count] @@
        m = re.match(r"^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@", line)
        if m:
            old_line = int(m.group(1))
            continue
        if old_line is None or current_file is None:
            continue
        if line.startswith("-"):
            content = line[1:]
            result.setdefault(current_file, []).append((old_line, content))
            old_line += 1
        elif line.startswith("+"):
            # added line — doesn't advance old line counter
            pass
        else:
            # context line
            old_line += 1

    return result


def parse_diff_additions(diff_text: str) -> list[str]:
    """
    Return a list of lines that were *added* in a diff
    (lines starting with '+', content only).
    """
    added: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
    return added


def lines_overlap(deleted_contents: list[str], added_contents: list[str]) -> list[str]:
    """
    Check if any of the deleted lines (content strings) appear in the
    added lines. Returns matching content strings.
    """
    deleted_set = set(c.strip() for c in deleted_contents)
    added_set = set(c.strip() for c in added_contents)
    overlap = deleted_set & added_set
    # Filter out trivial overlaps
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
    Check if merging the PR would remove lines that were recently added on main.

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

    # 1. Get PR metadata (head SHA)
    pr_data = gh_api(f"{api_base}/pulls/{pr_number}", token)

    # Skip merged PRs — the check is meaningless for them
    if pr_data.get("merged", False):
        print(f"PR #{pr_number} is already merged. Skipping.")
        return []

    head_sha = pr_data["head"]["sha"]
    head_ref = pr_data["head"]["ref"]

    # 2. Ensure we have up-to-date refs
    git("fetch", "origin", base_branch)
    try:
        git("fetch", "origin", head_ref)
    except RuntimeError:
        # If the remote ref isn't available, we already have the SHA
        pass

    # 3. Compute the diff: what would change on main if this PR were merged?
    # Using git diff base_branch..PR_HEAD shows lines that would be REMOVED from main
    try:
        merge_diff = git("diff", f"origin/{base_branch}", head_sha)
    except RuntimeError:
        # Fallback: try local ref
        merge_diff = git("diff", base_branch, head_sha)

    if not merge_diff.strip():
        return []

    # Filter out lockfiles and generated files that produce noisy false positives
    SKIP_PATTERNS = [
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        ".snap",
    ]
    deleted_lines_by_file = parse_diff_deletions(merge_diff)

    # Remove entries for lockfiles etc.
    deleted_lines_by_file = {
        f: entries
        for f, entries in deleted_lines_by_file.items()
        if not any(pat in f for pat in SKIP_PATTERNS)
    }

    if not deleted_lines_by_file:
        return []

    # 5. Get recent commits on base_branch
    log_output = git(
        "log", f"origin/{base_branch}",
        f"--since={lookback_days} days ago",
        "--format=%H %s",
    )

    recent_commits: list[tuple[str, str]] = []
    if log_output.strip():
        for line in log_output.strip().splitlines():
            parts = line.split(" ", 1)
            if len(parts) == 2:
                recent_commits.append((parts[0], parts[1]))

    # 6. For each file with deletions, check if recently-merged commits added those lines
    findings: list[dict] = []

    for filepath, deleted_entries in deleted_lines_by_file.items():
        deleted_contents = [content for _, content in deleted_entries]

        # Check each recent commit
        source_commits = []
        for sha, subject in recent_commits:
            # Get the diff for this commit, filtered to the file in question
            try:
                commit_diff = git("show", "--format=", sha, "--", filepath)
            except RuntimeError:
                continue

            if not commit_diff.strip():
                continue

            added_in_commit = parse_diff_additions(commit_diff)
            if not added_in_commit:
                continue

            overlap = lines_overlap(deleted_contents, added_in_commit)
            if overlap:
                # Extract PR number from subject like "(#255)" or "#255"
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
    try:
        gh_api(
            f"https://api.github.com/repos/{repo}/issues/comments/{comment_id}",
            token,
            method="DELETE",
        )
    except HTTPError as exc:
        print(f"Warning: Could not delete stale comment {comment_id}: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    dry_run = False

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

        # Clean up any existing comment from a previous run that found issues
        if token and not dry_run:
            try:
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
            except Exception as exc:
                print(f"Warning: Could not clean up stale comments: {exc}")
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