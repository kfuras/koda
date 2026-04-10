"""MCP server for Instagram — analytics and uploads."""
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

mcp = FastMCP("instagram-tools")

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
PYTHON = "python3"
CWD = Path(__file__).parent.parent


def _run_script(script_name: str, args: list[str] = None) -> str:
    cmd = [PYTHON, str(SCRIPTS_DIR / script_name)] + (args or [])
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120, cwd=str(CWD),
        )
        output = result.stdout + result.stderr
        return output[-3000:] if len(output) > 3000 else output
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def instagram_analytics(save: bool = True, as_json: bool = True, limit: int = 10) -> str:
    """Pull Instagram analytics — follower count, engagement rate, top performing recent posts. Returns JSON with metrics summary."""
    args = []
    if save:
        args.append("--save")
    if as_json:
        args.append("--json")
    if limit:
        args += ["--limit", str(limit)]
    return _run_script("instagram_analytics.py", args)


@mcp.tool()
def upload_instagram(video_path: str, caption: str, cover_image: str = "") -> str:
    """Upload a reel or post to Instagram. Pass video path and caption. Cover image is optional."""
    args = ["--video", video_path, "--caption", caption]
    if cover_image:
        args += ["--cover", cover_image]
    return _run_script("upload_instagram.py", args)


if __name__ == "__main__":
    mcp.run()
