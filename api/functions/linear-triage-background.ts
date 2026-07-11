// Netlify Background Function (the `-background` suffix makes it async).
// Receives a new-Issue payload from linear-webhook, formats it into the
// "Linear issue triage & delegation" Claude Code trigger's prompt, and fires
// that trigger via the Claude Code remote-trigger API.
//
// NOTE: the remote-trigger `run` endpoint's request body isn't publicly
// documented. This sends the per-run prompt override in the same shape the
// trigger's own stored job_config uses (job_config.ccr.events[].data.message).
// Verify with one live test issue after setting the env vars below — if the
// shape is wrong, the run will still fire but with the trigger's static
// default prompt instead of the issue content.

import { randomUUID } from 'crypto';
import { Sentry } from '../lib/sentry';

const LINEAR_TRIGGER_ID = process.env.LINEAR_TRIGGER_ID || '';
const LINEAR_TRIGGER_API_TOKEN = process.env.LINEAR_TRIGGER_API_TOKEN || '';
const TRIGGER_RUN_URL = `https://api.anthropic.com/v1/code/triggers/${LINEAR_TRIGGER_ID}/run`;

interface LinearIssueData {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  priority?: number;
  url?: string;
  team?: { key?: string; name?: string };
  state?: { name?: string };
}

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

function buildPrompt(issue: LinearIssueData): string {
  const identifier = issue.identifier || issue.id || 'unknown';
  const title = issue.title || '(no title)';
  const team = issue.team?.name || issue.team?.key || 'unknown team';
  const priority = PRIORITY_LABELS[issue.priority ?? -1] || 'unknown';
  const state = issue.state?.name || 'unknown';
  const description = issue.description || '(no description)';

  return `A new Linear issue was created for Unstream.

Issue: ${identifier} — ${title}
Team: ${team}
Priority: ${priority}
State: ${state}
Link: ${issue.url || 'unknown'}

Description:
${description}

Review the issue reported and diagnose the issue. Review the codebase to gain context on the product and the potential cause of the issue.

If the reported issue is a bug report and is feasible without further input, open a branch and attempt to fix the issue using codebase standards and best practices. Review the code to ensure the fix aligns with the product strategy and goals. Run all unit tests to ensure the fix does not break other product features. Then open a PR.

If the reported issue requires further context or is a product improvement/change, summarize the issue and a potential solution, and raise any open questions required to solve the issue. Do so in a Claude Code session (don't post an issue comment). Brandon will sort out the open questions with you there.`;
}

export async function handler(event: { body: string | null }) {
  if (!event.body) return { statusCode: 400 };

  if (!LINEAR_TRIGGER_ID || !LINEAR_TRIGGER_API_TOKEN) {
    Sentry.captureMessage('linear-triage-background: missing LINEAR_TRIGGER_ID or LINEAR_TRIGGER_API_TOKEN', {
      level: 'error',
    });
    return { statusCode: 500 };
  }

  const issue: LinearIssueData = JSON.parse(event.body);

  try {
    const response = await fetch(TRIGGER_RUN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINEAR_TRIGGER_API_TOKEN}`,
      },
      body: JSON.stringify({
        job_config: {
          ccr: {
            events: [
              {
                data: {
                  message: {
                    content: buildPrompt(issue),
                    role: 'user',
                    uuid: randomUUID(),
                  },
                },
              },
            ],
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Trigger run failed: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    Sentry.captureException(error, {
      tags: { source: 'linear-triage-background' },
      extra: { issueId: issue.id, identifier: issue.identifier },
    });
    return { statusCode: 500 };
  }

  return { statusCode: 200 };
}
