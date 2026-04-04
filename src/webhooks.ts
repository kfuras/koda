import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { WEBHOOK_PORT, WEBHOOK_SECRET } from "./config.js";
import { type KodaAgent } from "./agent.js";
import { type KodaBot } from "./bot.js";

function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true; // No secret = no verification
  const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");
  return signature === expected;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

interface GitHubEvent {
  action?: string;
  repository?: { full_name: string };
  pull_request?: { title: string; html_url: string; user: { login: string }; number: number };
  issue?: { title: string; html_url: string; user: { login: string }; number: number };
  pusher?: { name: string };
  ref?: string;
  commits?: Array<{ message: string }>;
}

export function startWebhookServer(agent: KodaAgent, bot: KodaBot): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/webhook/github") {
      res.writeHead(404);
      res.end();
      return;
    }

    const body = await readBody(req);
    const signature = req.headers["x-hub-signature-256"] as string ?? "";

    if (!verifySignature(body, signature)) {
      console.log("[webhook] Invalid signature — rejected");
      res.writeHead(401);
      res.end();
      return;
    }

    const event = req.headers["x-github-event"] as string;
    const payload = JSON.parse(body) as GitHubEvent;
    const repo = payload.repository?.full_name ?? "unknown";

    res.writeHead(200);
    res.end("ok");

    // Route events to the agent
    let prompt: string | null = null;

    switch (event) {
      case "pull_request": {
        const pr = payload.pull_request;
        if (pr && (payload.action === "opened" || payload.action === "reopened")) {
          prompt =
            `[GITHUB EVENT] New PR in ${repo}: #${pr.number} "${pr.title}" by ${pr.user.login}\n` +
            `URL: ${pr.html_url}\n\n` +
            `Review this PR. Check for issues, suggest improvements if needed. ` +
            `Record an observation about the change.`;
        }
        break;
      }
      case "issues": {
        const issue = payload.issue;
        if (issue && payload.action === "opened") {
          prompt =
            `[GITHUB EVENT] New issue in ${repo}: #${issue.number} "${issue.title}" by ${issue.user.login}\n` +
            `URL: ${issue.html_url}\n\n` +
            `Triage this issue. Is it a bug, feature request, or question? ` +
            `If it's something you can fix, propose a task.`;
        }
        break;
      }
      case "push": {
        const branch = payload.ref?.replace("refs/heads/", "") ?? "";
        const commits = payload.commits ?? [];
        if (branch === "main" && commits.length > 0) {
          const summary = commits.map(c => `- ${c.message}`).join("\n");
          prompt =
            `[GITHUB EVENT] Push to ${repo}/${branch} by ${payload.pusher?.name}\n` +
            `Commits:\n${summary}\n\n` +
            `Check if any of these changes affect scheduled tasks, scripts, or configs. ` +
            `Record an observation if relevant.`;
        }
        break;
      }
    }

    if (prompt) {
      console.log(`[webhook] ${event} from ${repo}`);
      agent.send(prompt, async (responseText) => {
        if (responseText && responseText.length > 10) {
          await bot.sendProactive(`**[github:${event}]** ${responseText}`);
        }
      });
    }
  });

  server.listen(WEBHOOK_PORT, () => {
    console.log(`Webhook server listening on port ${WEBHOOK_PORT}`);
  });
}
