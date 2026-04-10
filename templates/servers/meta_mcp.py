"""MCP server for Meta (Instagram + Facebook) — token management and analytics."""
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp[cli]", "requests"]
# ///

import json
import os
import re
import time
from pathlib import Path

# Load .env
_env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

from mcp.server.fastmcp import FastMCP
import requests

mcp = FastMCP("meta-tools")

GRAPH_API = "https://graph.facebook.com/v21.0"
APP_ID = os.environ.get("META_APP_ID", "925335136835518")
ENV_PATH = Path(__file__).parent.parent / ".env"


@mcp.tool()
def meta_check_token() -> str:
    """Check the Meta long-lived access token expiry. Returns validity status and days remaining. Run this before any Meta API calls to ensure the token is still valid."""
    token = os.environ.get("META_ACCESS_TOKEN", "")
    if not token:
        return json.dumps({"error": "META_ACCESS_TOKEN not set in ~/.koda/.env"})

    try:
        resp = requests.get(
            f"{GRAPH_API}/debug_token",
            params={"input_token": token, "access_token": token},
            timeout=15,
        )
        data = resp.json().get("data", {})
        expires_at = data.get("expires_at", 0)
        remaining_days = (expires_at - time.time()) / 86400 if expires_at else 0

        result = {
            "is_valid": data.get("is_valid", False),
            "remaining_days": round(remaining_days, 1),
            "expires_at": expires_at,
            "needs_refresh": remaining_days < 15,
        }
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def meta_refresh_token() -> str:
    """Refresh the Meta long-lived access token. Exchanges the current token for a new 60-day token and updates ~/.koda/.env. Only refreshes if less than 15 days remaining."""
    token = os.environ.get("META_ACCESS_TOKEN", "")
    app_secret = os.environ.get("META_APP_SECRET", "")

    if not token:
        return json.dumps({"error": "META_ACCESS_TOKEN not set"})
    if not app_secret:
        return json.dumps({"error": "META_APP_SECRET not set — needed for refresh"})

    try:
        # Check current expiry first
        check_resp = requests.get(
            f"{GRAPH_API}/debug_token",
            params={"input_token": token, "access_token": token},
            timeout=15,
        )
        check_data = check_resp.json().get("data", {})
        remaining = (check_data.get("expires_at", 0) - time.time()) / 86400

        if remaining > 15:
            return json.dumps({
                "refreshed": False,
                "reason": f"Token still has {remaining:.0f} days — no refresh needed",
            })

        # Exchange for new token
        resp = requests.get(
            f"{GRAPH_API}/oauth/access_token",
            params={
                "grant_type": "fb_exchange_token",
                "client_id": APP_ID,
                "client_secret": app_secret,
                "fb_exchange_token": token,
            },
            timeout=15,
        )
        data = resp.json()
        if "error" in data:
            return json.dumps({"error": f"Refresh failed: {data['error']['message']}"})

        new_token = data["access_token"]
        new_days = data.get("expires_in", 0) / 86400

        # Update .env file
        if ENV_PATH.exists():
            content = ENV_PATH.read_text()
            updated = re.sub(r"META_ACCESS_TOKEN=.*", f"META_ACCESS_TOKEN={new_token}", content)
            ENV_PATH.write_text(updated)
            os.environ["META_ACCESS_TOKEN"] = new_token

        return json.dumps({
            "refreshed": True,
            "new_expiry_days": round(new_days, 0),
            "env_updated": True,
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


if __name__ == "__main__":
    mcp.run()
