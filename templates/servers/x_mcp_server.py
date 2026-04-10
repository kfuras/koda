"""MCP server for X (Twitter) — posting, analytics, scanning, articles, and browser automation."""
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp[cli]", "tweepy", "requests", "requests-oauthlib"]
# ///

import os
import json
import base64
import subprocess
import tempfile
import requests
from requests_oauthlib import OAuth1
from pathlib import Path

# Load credentials from .env file (zero external dependencies)
_env_file = Path.home() / ".koda" / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("x-mcp")


def get_auth():
    """Return OAuth1 auth + tweepy v1 API (for media uploads only)."""
    import tweepy

    consumer_key = os.environ["X_CONSUMER_KEY"]
    consumer_secret = os.environ["X_CONSUMER_SECRET"]
    access_token = os.environ["X_ACCESS_TOKEN"]
    access_token_secret = os.environ["X_ACCESS_TOKEN_SECRET"]

    auth = OAuth1(consumer_key, consumer_secret, access_token, access_token_secret)

    tweepy_auth = tweepy.OAuth1UserHandler(
        consumer_key, consumer_secret, access_token, access_token_secret
    )
    api_v1 = tweepy.API(tweepy_auth)

    return auth, api_v1


def get_client():
    """Return a tweepy v2 Client for read/delete endpoints."""
    import tweepy

    return tweepy.Client(
        consumer_key=os.environ["X_CONSUMER_KEY"],
        consumer_secret=os.environ["X_CONSUMER_SECRET"],
        access_token=os.environ["X_ACCESS_TOKEN"],
        access_token_secret=os.environ["X_ACCESS_TOKEN_SECRET"],
    )


@mcp.tool()
def post_tweet(text: str, image_path: str = "", image_base64: str = "", image_mime_type: str = "image/png") -> str:
    """Post a tweet to X (Twitter) with optional image or video. Provide image_path for a file on disk (supports .jpg/.png/.gif/.mp4/.mov), or image_base64 for base64-encoded image data. Returns JSON with tweet URL."""
    try:
        auth, api_v1 = get_auth()

        media_ids = []
        actual_media_path = image_path

        # Handle base64 image
        if image_base64 and not image_path:
            ext = image_mime_type.split("/")[-1] if "/" in image_mime_type else "png"
            tmp = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
            tmp.write(base64.b64decode(image_base64))
            tmp.close()
            actual_media_path = tmp.name

        # Upload media if provided
        if actual_media_path:
            path = Path(actual_media_path)
            if not path.exists():
                return json.dumps({"success": False, "error": f"File not found: {actual_media_path}"})

            video_exts = {".mp4", ".mov", ".avi", ".webm"}
            if path.suffix.lower() in video_exts:
                media = api_v1.media_upload(
                    filename=str(path),
                    media_category="tweet_video",
                    chunked=True,
                )
            else:
                media = api_v1.media_upload(filename=str(path))
            media_ids.append(str(media.media_id))

        payload = {"text": text}
        if media_ids:
            payload["media"] = {"media_ids": media_ids}

        response = requests.post(
            "https://api.twitter.com/2/tweets",
            auth=auth,
            headers={"Content-Type": "application/json"},
            json=payload,
        )

        if not response.ok:
            return json.dumps({"success": False, "error": f"{response.status_code} {response.text}"}, indent=2)

        tweet_id = response.json()["data"]["id"]
        tweet_url = f"https://x.com/i/status/{tweet_id}"

        return json.dumps({
            "success": True,
            "id": tweet_id,
            "url": tweet_url,
            "text": text,
            "has_media": bool(media_ids)
        }, indent=2)

    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2)


@mcp.tool()
def get_my_tweets(count: int = 10) -> str:
    """Get your recent tweets. Returns JSON array of tweets with text, date, and metrics."""
    try:
        auth = OAuth1(
            os.environ["X_CONSUMER_KEY"],
            os.environ["X_CONSUMER_SECRET"],
            os.environ["X_ACCESS_TOKEN"],
            os.environ["X_ACCESS_TOKEN_SECRET"],
        )

        # First get the authenticated user's ID
        me_resp = requests.get("https://api.twitter.com/2/users/me", auth=auth)
        if not me_resp.ok:
            return json.dumps({"error": f"get_me failed: {me_resp.status_code} {me_resp.text}"}, indent=2)
        user_id = me_resp.json()["data"]["id"]

        # Fetch tweets
        tweets_resp = requests.get(
            f"https://api.twitter.com/2/users/{user_id}/tweets",
            auth=auth,
            params={
                "max_results": max(5, min(count, 100)),
                "tweet.fields": "created_at,public_metrics",
            },
        )
        if not tweets_resp.ok:
            return json.dumps({"error": f"{tweets_resp.status_code} {tweets_resp.text}"}, indent=2)

        data = tweets_resp.json().get("data", [])
        results = [
            {
                "id": t["id"],
                "text": t["text"],
                "created_at": t.get("created_at"),
                "metrics": t.get("public_metrics"),
            }
            for t in data
        ]
        return json.dumps(results, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


@mcp.tool()
def delete_tweet(tweet_id: str) -> str:
    """Delete a tweet by its ID."""
    try:
        client = get_client()
        client.delete_tweet(tweet_id)
        return json.dumps({"success": True, "deleted_id": tweet_id}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


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
def quote_tweet(url: str, text: str, video_path: str = "") -> str:
    """Post a quote tweet via Playwright browser automation. Uses saved X cookies for auth. Creates a proper embedded quote card. Pass the tweet URL to quote and your commentary text."""
    args = ["--url", url, "--text", text]
    if video_path:
        args += ["--video", video_path]
    return _run_script("quote_tweet_web.py", args)


@mcp.tool()
def scan_viral_tweets(min_likes: int = 100, limit: int = 10) -> str:
    """Scan X for viral tweets in the AI/automation niche using Playwright. Searches multiple queries, filters by engagement threshold. Returns JSON with top tweets including text, likes, retweets, author."""
    args = ["--min-likes", str(min_likes), "--limit", str(limit), "--json"]
    return _run_script("scan_viral_tweets.py", args)


@mcp.tool()
def publish_x_article(title: str, file_path: str, cover_image: str = "", dry_run: bool = False) -> str:
    """Write and publish an X Article via Playwright browser automation. X Articles support rich formatting: headings, bold, italic, code blocks, images. Pass the markdown file path. Use dry_run=true to fill the editor without publishing."""
    args = ["--title", title, "--file", file_path]
    if cover_image:
        args += ["--cover-image", cover_image]
    if dry_run:
        args.append("--dry-run")
    args.append("--record")
    return _run_script("publish_x_article.py", args)


@mcp.tool()
def x_article_pipeline(topic: str, angle: str = "") -> str:
    """Full X article pipeline: generate writing prompt with trending context, then produce a structured writing brief. Use this before publish_x_article to research and plan the article."""
    args = ["prompt", "--topic", topic]
    if angle:
        args += ["--angle", angle]
    return _run_script("x_article_pipeline.py", args)


@mcp.tool()
def export_x_cookies() -> str:
    """Re-export X browser cookies for Playwright scripts. Run this when quote_tweet or scan_viral_tweets fail with cookie/auth errors. Opens Chrome briefly to capture session cookies."""
    try:
        result = subprocess.run(
            ["node", str(SCRIPTS_DIR / "export-x-cookies.js")],
            capture_output=True, text=True, timeout=60, cwd=str(CWD),
        )
        return result.stdout + result.stderr
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def trending_topics(save: bool = True) -> str:
    """Scan X and the web for trending topics in AI/automation/Claude Code niche. Returns trending topics with engagement signals. Use save=true to persist results to data/."""
    args = []
    if save:
        args.append("--save")
    return _run_script("trending_topics.py", args)


if __name__ == "__main__":
    mcp.run()
