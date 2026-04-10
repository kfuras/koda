# Google OAuth Setup (YouTube, Gmail, GSC)

Google integrations require a one-time OAuth flow. This creates token files on your machine that the MCP servers use for authentication.

**This is optional.** Koda works without Google integrations.

## Prerequisites

- A Google account
- Python 3 with `google-auth-oauthlib` installed
- 10 minutes

## Step 1: Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g., "Koda Agent")
3. Enable these APIs (APIs & Services → Enable APIs):
   - **YouTube Data API v3** (for YouTube analytics + uploads)
   - **YouTube Analytics API** (for detailed metrics)
   - **Gmail API** (for email)
   - **Google Search Console API** (for SEO analytics)
   - **Indexing API** (for URL inspection)

## Step 2: Create OAuth Credentials

1. Go to APIs & Services → Credentials
2. Click "Create Credentials" → "OAuth client ID"
3. Application type: **Desktop app**
4. Name: "Koda" (or anything)
5. Download the JSON file → save as `~/.youtube-mcp/client_secret.json`

```bash
mkdir -p ~/.youtube-mcp
# Move your downloaded file:
mv ~/Downloads/client_secret_*.json ~/.youtube-mcp/client_secret.json
```

## Step 3: Configure OAuth Consent Screen

1. Go to APIs & Services → OAuth consent screen
2. User type: **External** (or Internal if using Google Workspace)
3. App name: "Koda"
4. Add your email as a test user
5. Add scopes:
   - `https://www.googleapis.com/auth/youtube` (YouTube read/write)
   - `https://www.googleapis.com/auth/yt-analytics.readonly` (YouTube analytics)
   - `https://www.googleapis.com/auth/gmail.modify` (Gmail)
   - `https://www.googleapis.com/auth/webmasters` (Search Console)
   - `https://www.googleapis.com/auth/indexing` (Indexing API)

## Step 4: Run the Auth Scripts

Each Google service stores its token separately:

### Google Search Console

```bash
pip3 install google-auth-oauthlib google-api-python-client

# Run the auth flow (opens browser)
python3 scripts/gsc-auth.py
```

This saves `~/.gsc-mcp/token.json`. The same `client_secret.json` from Step 2 is reused.

### YouTube

YouTube MCP is a separate package:

```bash
npm install -g youtube-studio-mcp
# Follow its setup instructions for OAuth
```

Token is stored by the youtube-studio-mcp package.

### Gmail

Gmail MCP is a separate project:

```bash
git clone <gmail-mcp-repo> ~/code/gmail-mcp
cd ~/code/gmail-mcp
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Run its auth flow
```

## Token Locations

| Service | Token file | Created by |
|---|---|---|
| GSC | `~/.gsc-mcp/token.json` | `python3 scripts/gsc-auth.py` |
| YouTube | Managed by `youtube-studio-mcp` | npm package setup |
| Gmail | `~/code/gmail-mcp/` | Separate repo auth flow |

## Token Refresh

OAuth tokens auto-refresh using the refresh token stored in the JSON file. You only need to run the auth script once. If a token expires completely (rare — usually lasts indefinitely with refresh), re-run the auth script.

## Troubleshooting

- **"Access blocked" error**: Add your email as a test user in the OAuth consent screen
- **"Scope not authorized"**: Make sure all required scopes are added in Step 3
- **Token expired**: Re-run the auth script for that service
- **client_secret.json not found**: Check the path matches what the auth script expects (`~/.youtube-mcp/client_secret.json`)

## Security

- Token files contain refresh tokens — treat them like passwords
- Never commit `client_secret.json` or `token.json` to git
- The files are stored outside `~/.koda/` so they're not affected by Koda backup/restore
