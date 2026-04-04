#!/usr/bin/env python3
"""One-time OAuth flow for Google Search Console API.
Uses the same client_secret as YouTube MCP.
Run once, authenticates in browser, saves token to ~/.gsc-mcp/token.json
"""

import json
import os
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

TOKEN_DIR = Path.home() / ".gsc-mcp"
TOKEN_FILE = TOKEN_DIR / "token.json"
CLIENT_SECRET = Path.home() / ".youtube-mcp" / "client_secret.json"

SCOPES = [
    "https://www.googleapis.com/auth/webmasters",        # Search Console (read/write)
    "https://www.googleapis.com/auth/indexing",           # Indexing API
]

def main():
    TOKEN_DIR.mkdir(exist_ok=True)

    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
            creds = flow.run_local_server(port=8090)

        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
        print(f"Token saved to {TOKEN_FILE}")

    # Test
    from googleapiclient.discovery import build
    service = build("searchconsole", "v1", credentials=creds)
    sites = service.sites().list().execute()
    print(f"\nAuthenticated! Sites found: {len(sites.get('siteEntry', []))}")
    for site in sites.get("siteEntry", []):
        print(f"  {site['siteUrl']} ({site['permissionLevel']})")

if __name__ == "__main__":
    main()
