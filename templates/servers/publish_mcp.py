"""MCP server for multi-platform video publishing with Discord approval flow."""
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp[cli]"]
# ///

import json
import os
import subprocess
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

mcp = FastMCP("publish-tools")

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
PYTHON = "python3"
CWD = Path(__file__).parent.parent


def _run_script(script_name: str, args: list[str] = None) -> str:
    cmd = [PYTHON, str(SCRIPTS_DIR / script_name)] + (args or [])
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600, cwd=str(CWD),
        )
        output = result.stdout + result.stderr
        return output[-3000:] if len(output) > 3000 else output
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def publish_video(video_path: str, title: str, description: str, platforms: str = "youtube") -> str:
    """Publish a video to YouTube/Instagram/TikTok with Discord approval flow. Compresses a preview, sends to the #publish channel, waits for reaction. Platforms: 'youtube', 'instagram', 'tiktok', or comma-separated for multiple."""
    args = [video_path, "--title", title, "--description", description, "--platforms", platforms]
    return _run_script("publish.py", args)


@mcp.tool()
def devto_crosspost(title: str, markdown_body: str, canonical_url: str, tags: str = "ai,automation,claudecode") -> str:
    """Cross-post a blog article to dev.to with canonical URL pointing back to kjetilfuras.com. The canonical_url ensures Google credits the original site, not dev.to."""
    import requests as req

    api_key = os.environ.get("DEVTO_API_KEY", "")
    if not api_key:
        return json.dumps({"error": "DEVTO_API_KEY not set in ~/.koda/.env"})

    try:
        resp = req.post(
            "https://dev.to/api/articles",
            headers={"Content-Type": "application/json", "api-key": api_key},
            json={
                "article": {
                    "title": title,
                    "body_markdown": markdown_body,
                    "published": True,
                    "canonical_url": canonical_url,
                    "tags": [t.strip() for t in tags.split(",")],
                }
            },
            timeout=30,
        )
        if resp.ok:
            data = resp.json()
            return json.dumps({"success": True, "url": data.get("url"), "id": data.get("id")}, indent=2)
        return json.dumps({"error": f"{resp.status_code}: {resp.text[:300]}"})
    except Exception as e:
        return json.dumps({"error": str(e)})


if __name__ == "__main__":
    mcp.run()
