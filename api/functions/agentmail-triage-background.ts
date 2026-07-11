// Netlify Background Function (the `-background` suffix makes it async).
// Receives a message.received payload from agentmail-webhook, formats it into
// the "Inbound support email triage" Claude Code trigger's prompt, and fires
// that trigger via the Claude Code remote-trigger API.
//
// NOTE: the remote-trigger `run` endpoint's request body isn't publicly
// documented. This sends the per-run prompt override in the same shape the
// trigger's own stored job_config uses (job_config.ccr.events[].data.message).
// Verify with one live test email after setting the env vars below — if the
// shape is wrong, the run will still fire but with the trigger's static
// default prompt instead of the email content.

import { randomUUID } from 'crypto';
import { Sentry } from '../lib/sentry';

const CLAUDE_TRIGGER_ID = process.env.CLAUDE_TRIGGER_ID || '';
const CLAUDE_TRIGGER_API_TOKEN = process.env.CLAUDE_TRIGGER_API_TOKEN || '';
const TRIGGER_RUN_URL = `https://api.anthropic.com/v1/code/triggers/${CLAUDE_TRIGGER_ID}/run`;

interface AgentMailMessage {
  message_id?: string;
  thread_id?: string;
  inbox_id?: string;
  from_?: string[];
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
}

function buildPrompt(message: AgentMailMessage): string {
  const from = message.from_?.join(', ') || 'unknown sender';
  const subject = message.subject || '(no subject)';
  const body =
    message.text ||
    message.html ||
    '(body omitted — the webhook payload exceeded 1MB; fetch the full message via the AgentMail API if needed)';

  return `You just received an email from a user of Unstream.

From: ${from}
Subject: ${subject}
Thread ID: ${message.thread_id || 'unknown'}

Message body:
${body}

Review the issue reported and diagnose the issue. Review the codebase to gain context on the product and the potential cause of the issue.

If the reported issue is a bug report and is feasible without further input, open a branch and attempt to fix the issue using codebase standards and best practices. Review the code to ensure the fix aligns with the product strategy and goals. Run all unit tests to ensure the fix does not break other product features. Then open a PR.

If the reported issue requires further context or is a product improvement/change, summarize the issue and a potential solution, and raise any open questions required to solve the issue. Do so in a Claude Code session (don't post an issue comment). Brandon will sort out the open questions with you there.`;
}

export async function handler(event: { body: string | null }) {
  if (!event.body) return { statusCode: 400 };

  if (!CLAUDE_TRIGGER_ID || !CLAUDE_TRIGGER_API_TOKEN) {
    Sentry.captureMessage('agentmail-triage-background: missing CLAUDE_TRIGGER_ID or CLAUDE_TRIGGER_API_TOKEN', {
      level: 'error',
    });
    return { statusCode: 500 };
  }

  const message: AgentMailMessage = JSON.parse(event.body);

  try {
    const response = await fetch(TRIGGER_RUN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLAUDE_TRIGGER_API_TOKEN}`,
      },
      body: JSON.stringify({
        job_config: {
          ccr: {
            events: [
              {
                data: {
                  message: {
                    content: buildPrompt(message),
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
      tags: { source: 'agentmail-triage-background' },
      extra: { threadId: message.thread_id, messageId: message.message_id },
    });
    return { statusCode: 500 };
  }

  return { statusCode: 200 };
}
