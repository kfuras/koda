# MCP Servers

Koda uses per-service MCP (Model Context Protocol) servers to interact with external APIs. Each server runs as a local Python process, communicating with the agent via JSON-RPC over stdin/stdout.

`koda init` copies these to `~/.koda/servers/`. They load credentials from `~/.koda/.env`.

## Servers

### x_mcp_server.py — X (Twitter)

**9 tools:** post_tweet, get_my_tweets, delete_tweet, quote_tweet, scan_viral_tweets, publish_x_article, x_article_pipeline, export_x_cookies, trending_topics

**Required env vars:**
```
X_CONSUMER_KEY=
X_CONSUMER_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

**Optional (for Playwright browser automation):**
```
X_EMAIL=
X_PASSWORD=
```

**Setup:** Create an app at [developer.x.com](https://developer.x.com), enable OAuth 1.0a with read/write permissions.

---

### bluesky_mcp.py — Bluesky

**5 tools:** bluesky_create_post (text + images + **video**), bluesky_delete_post, bluesky_get_profile, bluesky_get_timeline, bluesky_get_my_posts

**Required env vars:**
```
BLUESKY_HANDLE=user.bsky.social
BLUESKY_APP_PASSWORD=
```

**Setup:** Go to Bluesky Settings → App Passwords → Generate.

---

### content_mcp.py — Content Generation

**5 tools:** generate_image (Gemini), generate_thumbnail, search_reaction_clip (yt-dlp), voice_short (ElevenLabs), research_topics

**Required env vars (per tool):**
```
GEMINI_API_KEY=          # generate_image, generate_thumbnail
ELEVENLABS_API_KEY=      # voice_short
```

`search_reaction_clip` uses yt-dlp (no API key needed, must be installed: `brew install yt-dlp`).

---

### skool_mcp.py — Skool Community

**6 tools:** skool_get_community, skool_get_posts (public, no auth), skool_create_post, skool_delete_post, skool_pin_post (auth required), skool_sync_members (Playwright + Airtable)

**Required env vars (for write operations):**
```
SKOOL_EMAIL=
SKOOL_PASSWORD=
SKOOL_GROUP_ID=build-automate
```

**Note:** Read operations (get_community, get_posts) work on public groups without auth. Write operations require session cookies from a Playwright login.

---

### instagram_mcp.py — Instagram

**2 tools:** instagram_analytics, upload_instagram

**Required env vars:**
```
META_ACCESS_TOKEN=
INSTAGRAM_BUSINESS_ACCOUNT_ID=
```

**Setup:** See `docs/google-oauth-setup.md` for Meta Graph API token setup.

---

### meta_mcp.py — Meta Token Management

**2 tools:** meta_check_token, meta_refresh_token

**Required env vars:**
```
META_ACCESS_TOKEN=
META_APP_SECRET=
```

Long-lived tokens expire after 60 days. `meta_check_token` reports remaining days. `meta_refresh_token` exchanges for a new 60-day token and updates `~/.koda/.env`.

---

### publish_mcp.py — Multi-Platform Publishing

**2 tools:** publish_video (YouTube/Instagram/TikTok with Discord approval), devto_crosspost

**Required env vars:**
```
DISCORD_BOT_TOKEN=       # publish_video (Discord approval flow)
DISCORD_PUBLISH_CHANNEL= # Channel for approval messages
DEVTO_API_KEY=           # devto_crosspost
```

---

## Adding to mcp-servers.json

After `koda init` copies the servers to `~/.koda/servers/`, register them in `~/.koda/mcp-servers.json`:

```json
{
  "x-mcp": {
    "command": "python3",
    "args": ["~/.koda/servers/x_mcp_server.py"]
  },
  "bluesky-mcp": {
    "command": "python3",
    "args": ["~/.koda/servers/bluesky_mcp.py"]
  }
}
```

Only add servers you have credentials for. Koda works fine with a subset.

## Google Integrations (YouTube, Gmail, GSC)

These use OAuth token files, not env vars. See [docs/google-oauth-setup.md](../../docs/google-oauth-setup.md) for setup instructions. They are separate MCP servers not included in this directory — install them from their own repos.
