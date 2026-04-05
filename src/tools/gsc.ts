import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PYTHON = "python3";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function runGsc(script: string): Promise<string> {
  const { stdout } = await execFileAsync(PYTHON, ["-c", script], {
    timeout: 30_000,
    env: { ...process.env },
  });
  return stdout;
}

const GSC_AUTH = `
import json
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from pathlib import Path

def get_creds():
    token_file = Path.home() / ".gsc-mcp" / "token.json"
    creds = Credentials.from_authorized_user_file(str(token_file))
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(token_file, "w") as f:
            f.write(creds.to_json())
    return creds
`;

// --- Tools ---

const searchAnalytics = tool(
  "gsc_search_analytics",
  "Pull Google Search Console analytics for a site. Returns search queries, clicks, impressions, CTR, and position.",
  {
    site_url: z.string().describe("Site URL (e.g., 'sc-domain:example.com' or 'https://example.com/')"),
    days: z.number().default(7).describe("Number of days to look back"),
    dimensions: z.string().default("query").describe("Comma-separated: query, page, country, device, date"),
    row_limit: z.number().default(10),
  },
  async ({ site_url, days, dimensions, row_limit }) => {
    const script = `
${GSC_AUTH}
from googleapiclient.discovery import build
from datetime import datetime, timedelta
import json

creds = get_creds()
service = build("searchconsole", "v1", credentials=creds)

end = datetime.now().strftime("%Y-%m-%d")
start = (datetime.now() - timedelta(days=${days})).strftime("%Y-%m-%d")

result = service.searchanalytics().query(
    siteUrl="${site_url}",
    body={
        "startDate": start,
        "endDate": end,
        "dimensions": ${JSON.stringify(dimensions.split(",").map(d => d.trim()))},
        "rowLimit": ${row_limit},
    }
).execute()

print(json.dumps(result, indent=2))
`;
    const output = await runGsc(script);
    return textResult(output);
  },
);

const listSites = tool(
  "gsc_list_sites",
  "List all sites in Google Search Console.",
  {},
  async () => {
    const script = `
${GSC_AUTH}
from googleapiclient.discovery import build
import json

creds = get_creds()
service = build("searchconsole", "v1", credentials=creds)
sites = service.sites().list().execute()
print(json.dumps(sites, indent=2))
`;
    const output = await runGsc(script);
    return textResult(output);
  },
);

const submitSitemap = tool(
  "gsc_submit_sitemap",
  "Submit a sitemap to Google Search Console.",
  {
    site_url: z.string().describe("Site URL (e.g., 'sc-domain:notipo.com')"),
    sitemap_url: z.string().url().describe("Full URL of the sitemap (e.g., 'https://notipo.com/sitemap.xml')"),
  },
  async ({ site_url, sitemap_url }) => {
    const script = `
${GSC_AUTH}
from googleapiclient.discovery import build

creds = get_creds()
service = build("searchconsole", "v1", credentials=creds)
service.sitemaps().submit(siteUrl="${site_url}", feedpath="${sitemap_url}").execute()
print("Sitemap submitted: ${sitemap_url}")
`;
    const output = await runGsc(script);
    return textResult(output);
  },
);

const requestIndexing = tool(
  "gsc_request_indexing",
  "Request Google to index a specific URL. Use after publishing new content.",
  {
    url: z.string().url().describe("The URL to request indexing for"),
  },
  async ({ url }) => {
    const script = `
${GSC_AUTH}
from googleapiclient.discovery import build

creds = get_creds()
service = build("indexing", "v3", credentials=creds)
result = service.urlNotifications().publish(
    body={"url": "${url}", "type": "URL_UPDATED"}
).execute()
import json
print(json.dumps(result, indent=2))
`;
    const output = await runGsc(script);
    return textResult(output);
  },
);

const inspectUrl = tool(
  "gsc_inspect_url",
  "Check the indexing status of a URL in Google Search Console.",
  {
    site_url: z.string().describe("Site URL (e.g., 'sc-domain:notipo.com')"),
    inspection_url: z.string().url().describe("The URL to inspect"),
  },
  async ({ site_url, inspection_url }) => {
    const script = `
${GSC_AUTH}
from googleapiclient.discovery import build
import json

creds = get_creds()
service = build("searchconsole", "v1", credentials=creds)
result = service.urlInspection().index().inspect(
    body={"inspectionUrl": "${inspection_url}", "siteUrl": "${site_url}"}
).execute()
print(json.dumps(result, indent=2))
`;
    const output = await runGsc(script);
    return textResult(output);
  },
);

// --- MCP Server ---

export const gscServer = createSdkMcpServer({
  name: "gsc",
  version: "0.1.0",
  tools: [searchAnalytics, listSites, submitSitemap, requestIndexing, inspectUrl],
});
