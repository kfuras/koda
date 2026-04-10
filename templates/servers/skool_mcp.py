"""MCP server for Skool — community management via reverse-engineered API + Playwright."""
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp[cli]", "requests", "playwright"]
# ///

import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

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

mcp = FastMCP("skool-tools")

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
GROUP_ID = os.environ.get("SKOOL_GROUP_ID", "build-automate")
API_BASE = "https://api2.skool.com"
PYTHON = "python3"


def _get_nextdata(slug_path: str) -> dict:
    """Fetch data from Skool's Next.js data route (public, no auth needed)."""
    # First get the buildId from the main page
    resp = requests.get(
        f"https://www.skool.com/{GROUP_ID}",
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=15,
    )
    html = resp.text

    import re
    match = re.search(r'"buildId":"([^"]+)"', html)
    if not match:
        # Try __NEXT_DATA__ approach
        nd_match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html)
        if nd_match:
            nd = json.loads(nd_match.group(1))
            return nd.get("props", {}).get("pageProps", {})
        raise RuntimeError("Could not find Skool buildId")

    build_id = match.group(1)
    data_url = f"https://www.skool.com/_next/data/{build_id}/{GROUP_ID}{slug_path}.json"

    data_resp = requests.get(
        data_url,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=15,
    )
    return data_resp.json().get("pageProps", {})


def _get_session_cookies() -> dict:
    """Load Skool session cookies for authenticated API calls."""
    cookie_file = Path(__file__).parent.parent / "data" / ".skool-cookies.json"
    if cookie_file.exists():
        cookies = json.loads(cookie_file.read_text())
        if isinstance(cookies, list):
            return {c["name"]: c["value"] for c in cookies}
        return cookies
    return {}


def _api_request(method: str, path: str, data: dict = None) -> dict:
    """Make an authenticated request to api2.skool.com."""
    cookies = _get_session_cookies()
    if not cookies:
        return {"error": "No Skool session cookies. Run Playwright login first."}

    headers = {
        "Content-Type": "application/json",
        "Origin": "https://www.skool.com",
        "Referer": f"https://www.skool.com/{GROUP_ID}",
    }

    resp = requests.request(
        method,
        f"{API_BASE}{path}",
        headers=headers,
        cookies=cookies,
        json=data,
        timeout=30,
    )

    try:
        return resp.json()
    except Exception:
        return {"status_code": resp.status_code, "text": resp.text[:500]}


@mcp.tool()
def skool_get_community() -> str:
    """Get community info: name, description, member count, online users, categories, pricing. Uses public API — no auth needed."""
    try:
        data = _get_nextdata("/about")
        group = data.get("currentGroup", {})
        meta = group.get("metadata", {})

        result = {
            "name": group.get("name"),
            "display_name": meta.get("displayName"),
            "description": meta.get("description"),
            "total_members": meta.get("totalMembers"),
            "total_posts": meta.get("totalPosts"),
            "total_online": meta.get("totalOnlineMembers"),
            "num_courses": meta.get("numCourses"),
            "num_modules": meta.get("numModules"),
            "price": meta.get("displayPrice"),
            "privacy": "public" if meta.get("privacy") == 0 else "private",
            "plan": meta.get("plan"),
            "categories": [
                {
                    "name": l["metadata"].get("displayName", ""),
                    "posts": l["metadata"].get("posts", 0),
                }
                for l in group.get("labels", [])
            ],
        }
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def skool_get_posts(limit: int = 10) -> str:
    """Get recent community feed posts. Returns title, author, likes, comments, date. Uses public API — no auth needed."""
    try:
        data = _get_nextdata("")
        rd = data.get("renderData", {})
        trees = rd.get("postTrees", [])

        posts = []
        for t in trees[:limit]:
            p = t.get("post", {})
            meta = p.get("metadata", {})
            user = p.get("user", {}) or {}
            posts.append({
                "title": meta.get("title", "<no title>"),
                "author": user.get("metadata", {}).get("firstName", user.get("name", "?")),
                "upvotes": meta.get("upvotes", 0),
                "comments": meta.get("numComments", 0),
                "pinned": meta.get("pinned", False),
                "created": p.get("createdAt", "")[:10],
            })

        return json.dumps({"total": rd.get("total", 0), "posts": posts}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def skool_create_post(title: str, content: str, category: str = "") -> str:
    """Create a new community post in the Skool group. Requires authenticated session cookies. Category is the label display name (e.g., 'General discussion')."""
    group_id_hex = os.environ.get("SKOOL_GROUP_HEX_ID", "41f91f47be374a35a94f6c0250f50cc4")

    data = {
        "group_id": group_id_hex,
        "post_type": "generic",
        "metadata": {
            "title": title,
            "content": content,
        },
    }
    if category:
        data["metadata"]["labels"] = [category]

    result = _api_request("POST", "/posts", data)
    return json.dumps(result, indent=2)


@mcp.tool()
def skool_delete_post(post_id: str) -> str:
    """Delete a community post by ID. Requires authenticated session cookies."""
    result = _api_request("DELETE", f"/posts/{post_id}")
    return json.dumps(result, indent=2)


@mcp.tool()
def skool_pin_post(post_id: str, pinned: bool = True) -> str:
    """Pin or unpin a community post. Requires authenticated session cookies."""
    result = _api_request("PATCH", f"/posts/{post_id}", {"metadata": {"pinned": pinned}})
    return json.dumps(result, indent=2)


@mcp.tool()
def skool_sync_members() -> str:
    """Export Skool members via Playwright, diff against previous sync, and upsert to Airtable. Returns summary of new, churned, and upgraded members."""
    try:
        result = subprocess.run(
            [PYTHON, str(SCRIPTS_DIR / "skool-airtable-sync.py")],
            capture_output=True, text=True, timeout=120,
            cwd=str(SCRIPTS_DIR.parent),
        )
        output = result.stdout + result.stderr
        return output[-3000:] if len(output) > 3000 else output
    except Exception as e:
        return json.dumps({"error": str(e)})


if __name__ == "__main__":
    mcp.run()
