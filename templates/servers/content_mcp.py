"""MCP server for content generation — images, thumbnails, video, voice, research."""
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp[cli]", "requests"]
# ///

import base64
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

mcp = FastMCP("content-tools")

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
PYTHON = "python3"
CWD = Path(__file__).parent.parent


def _run_script(script_name: str, args: list[str] = None) -> str:
    """Run a script from ~/.koda/scripts/ and return output."""
    cmd = [PYTHON, str(SCRIPTS_DIR / script_name)] + (args or [])
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300, cwd=str(CWD),
        )
        output = result.stdout + result.stderr
        return output[-3000:] if len(output) > 3000 else output
    except subprocess.TimeoutExpired:
        return json.dumps({"error": f"{script_name} timed out after 300s"})
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def generate_image(prompt: str, output_path: str = "", aspect_ratio: str = "16:9") -> str:
    """Generate an image using Google Gemini API from a text prompt. Saves to ~/.koda/data/generated-images/ by default. Returns JSON with file path and size."""
    try:
        import requests

        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return json.dumps({"error": "GEMINI_API_KEY not set in ~/.koda/.env"})

        if not output_path:
            output_path = str(Path.home() / ".koda" / "data" / "generated-images" / "latest.jpg")

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        model = "gemini-3-pro-image-preview"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

        resp = requests.post(
            url,
            headers={"Content-Type": "application/json"},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseModalities": ["TEXT", "IMAGE"],
                    "imageConfig": {"aspectRatio": aspect_ratio},
                },
            },
            timeout=90,
        )

        if not resp.ok:
            return json.dumps({"error": f"Gemini API error {resp.status_code}: {resp.text[:300]}"})

        data = resp.json()
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        image_part = next(
            (p for p in parts if p.get("inlineData", {}).get("mimeType", "").startswith("image/")),
            None,
        )

        if not image_part:
            return json.dumps({"error": "Gemini returned no image"})

        image_bytes = base64.b64decode(image_part["inlineData"]["data"])
        with open(output_path, "wb") as f:
            f.write(image_bytes)

        return json.dumps({"success": True, "path": output_path, "size_bytes": len(image_bytes)}, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


@mcp.tool()
def generate_thumbnail(title: str, output_path: str = "", style: str = "article") -> str:
    """Generate a thumbnail image for a blog post or video. Style can be 'article' (1200x630) or 'youtube' (1280x720)."""
    args = [title]
    if output_path:
        args += ["--output", output_path]
    if style:
        args += ["--style", style]
    return _run_script("generate_thumbnail.py", args)


@mcp.tool()
def search_reaction_clip(query: str, max_duration: int = 12, download: bool = True) -> str:
    """Search YouTube for a short reaction clip (HD MP4) to attach to tweets. Pass a mood/energy like 'mind blown', 'coach hype'. Downloads via yt-dlp, trimmed to specified max duration."""
    args = ["--query", query, "--max-duration", str(max_duration)]
    if download:
        args.append("--download")
    args.append("--json")
    return _run_script("search_reaction_clip.py", args)


@mcp.tool()
def voice_short(video_path: str, script: str, voice_id: str = "", output: str = "") -> str:
    """Add AI voiceover to a video using ElevenLabs TTS. Pass the input video and the narration script text. Returns the output video path with voice + captions."""
    args = ["--video", video_path, "--script", script]
    if voice_id:
        args += ["--voice-id", voice_id]
    if output:
        args += ["--output", output]
    return _run_script("voice_short.py", args)


@mcp.tool()
def research_topics(query: str = "", save: bool = True) -> str:
    """Deep research on a topic — scan web, X, and news for content angles, trends, and data points. Returns structured research findings."""
    args = []
    if query:
        args += ["--query", query]
    if save:
        args.append("--save")
    return _run_script("research_topics.py", args)


if __name__ == "__main__":
    mcp.run()
