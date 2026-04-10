"""MCP server for Bluesky — posting (text, images, video), reading, analytics."""
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp[cli]", "requests"]
# ///

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

# Load .env
_env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("bluesky-mcp")

BLUESKY_API = "https://bsky.social/xrpc"

# Session cache (reused across tool calls within the same process)
_session_cache = {}


def _create_session() -> dict:
    """Authenticate with Bluesky and return session tokens."""
    if _session_cache.get("accessJwt"):
        return _session_cache

    handle = os.environ.get("BLUESKY_HANDLE", "")
    password = os.environ.get("BLUESKY_APP_PASSWORD", "")
    if not handle or not password:
        raise RuntimeError("BLUESKY_HANDLE and BLUESKY_APP_PASSWORD must be set in ~/.koda/.env")

    resp = requests.post(
        f"{BLUESKY_API}/com.atproto.server.createSession",
        json={"identifier": handle, "password": password},
        timeout=15,
    )
    resp.raise_for_status()
    session = resp.json()
    _session_cache.update(session)
    return session


def _detect_facets(text: str) -> list:
    """Detect URLs in text and return Bluesky facets for rich link rendering."""
    facets = []
    for match in re.finditer(r"https?://\S+", text):
        start = len(text[:match.start()].encode("utf-8"))
        end = len(text[:match.end()].encode("utf-8"))
        facets.append({
            "index": {"byteStart": start, "byteEnd": end},
            "features": [{"$type": "app.bsky.richtext.facet#link", "uri": match.group()}],
        })
    return facets


def _upload_image(session: dict, image_path: str) -> tuple:
    """Upload an image and return (blob, width, height)."""
    from PIL import Image

    path = Path(image_path)
    data = path.read_bytes()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}
    content_type = mime.get(path.suffix.lower().strip("."), "image/jpeg")

    resp = requests.post(
        f"{BLUESKY_API}/com.atproto.repo.uploadBlob",
        headers={"Authorization": f"Bearer {session['accessJwt']}", "Content-Type": content_type},
        data=data,
        timeout=30,
    )
    resp.raise_for_status()
    blob = resp.json()["blob"]

    img = Image.open(path)
    width, height = img.size

    return blob, width, height


def _upload_video(session: dict, video_path: str) -> dict:
    """Upload a video to Bluesky's video service. Returns blob for embedding."""
    import time

    path = Path(video_path)
    video_data = path.read_bytes()
    suffix = path.suffix.lower()
    mime_map = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
    mime_type = mime_map.get(suffix, "video/mp4")

    # Service auth for video upload
    pds_url = session.get("didDoc", {}).get("service", [{}])[0].get("serviceEndpoint", "")
    pds_did = pds_url.replace("https://", "did:web:") if pds_url else "did:web:bsky.network"

    svc_resp = requests.get(
        f"{BLUESKY_API}/com.atproto.server.getServiceAuth",
        headers={"Authorization": f"Bearer {session['accessJwt']}"},
        params={
            "aud": pds_did,
            "lxm": "com.atproto.repo.uploadBlob",
            "exp": int(datetime.now(timezone.utc).timestamp()) + 1800,
        },
    )
    svc_resp.raise_for_status()
    svc_token = svc_resp.json()["token"]

    # Upload
    resp = requests.post(
        "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
        headers={"Authorization": f"Bearer {svc_token}", "Content-Type": mime_type},
        params={"did": session["did"], "name": path.name},
        data=video_data,
        timeout=120,
    )
    resp.raise_for_status()
    job = resp.json()
    job_id = job.get("jobId") or job.get("jobStatus", {}).get("jobId")

    # Poll for completion
    for _ in range(60):
        status_resp = requests.get(
            "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            params={"jobId": job_id},
        )
        status_resp.raise_for_status()
        status = status_resp.json().get("jobStatus", {})
        state = status.get("state")
        if state == "JOB_STATE_COMPLETED":
            return status["blob"]
        elif state == "JOB_STATE_FAILED":
            raise RuntimeError(f"Video processing failed: {status.get('error', 'unknown')}")
        time.sleep(2)

    raise TimeoutError("Video processing timed out after 120s")


@mcp.tool()
def bluesky_create_post(text: str, image_path: str = "", video_path: str = "", alt_text: str = "") -> str:
    """Post to Bluesky with optional image or video. Supports .jpg/.png/.gif for images, .mp4/.mov/.webm for video. URLs in text are automatically converted to clickable links."""
    try:
        session = _create_session()

        record = {
            "$type": "app.bsky.feed.post",
            "text": text,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        facets = _detect_facets(text)
        if facets:
            record["facets"] = facets

        # Video takes priority over image
        if video_path:
            blob = _upload_video(session, video_path)
            record["embed"] = {
                "$type": "app.bsky.embed.video",
                "video": blob,
                "alt": alt_text or text[:100],
            }
        elif image_path:
            blob, width, height = _upload_image(session, image_path)
            record["embed"] = {
                "$type": "app.bsky.embed.images",
                "images": [{"alt": alt_text or text[:100], "image": blob, "aspectRatio": {"width": width, "height": height}}],
            }

        resp = requests.post(
            f"{BLUESKY_API}/com.atproto.repo.createRecord",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            json={"repo": session["did"], "collection": "app.bsky.feed.post", "record": record},
        )
        resp.raise_for_status()
        data = resp.json()

        rkey = data["uri"].split("/")[-1]
        url = f"https://bsky.app/profile/{os.environ['BLUESKY_HANDLE']}/post/{rkey}"

        return json.dumps({"success": True, "uri": data["uri"], "url": url, "text": text}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


@mcp.tool()
def bluesky_delete_post(uri: str) -> str:
    """Delete a Bluesky post by its AT URI (at://did:.../app.bsky.feed.post/rkey)."""
    try:
        session = _create_session()
        rkey = uri.split("/")[-1]

        resp = requests.post(
            f"{BLUESKY_API}/com.atproto.repo.deleteRecord",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            json={"repo": session["did"], "collection": "app.bsky.feed.post", "rkey": rkey},
        )
        return json.dumps({"success": resp.status_code == 200, "deleted": uri}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


@mcp.tool()
def bluesky_get_profile() -> str:
    """Get your Bluesky profile — display name, handle, follower/following counts, post count."""
    try:
        session = _create_session()
        resp = requests.get(
            f"{BLUESKY_API}/app.bsky.actor.getProfile",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            params={"actor": session["did"]},
        )
        resp.raise_for_status()
        p = resp.json()
        return json.dumps({
            "handle": p.get("handle"),
            "displayName": p.get("displayName"),
            "followers": p.get("followersCount"),
            "following": p.get("followsCount"),
            "posts": p.get("postsCount"),
            "description": p.get("description", "")[:200],
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


@mcp.tool()
def bluesky_get_timeline(limit: int = 20) -> str:
    """Get your Bluesky home timeline — recent posts from people you follow. Returns text, author, likes, reposts."""
    try:
        session = _create_session()
        resp = requests.get(
            f"{BLUESKY_API}/app.bsky.feed.getTimeline",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            params={"limit": min(limit, 50)},
        )
        resp.raise_for_status()
        feed = resp.json().get("feed", [])

        posts = []
        for item in feed:
            p = item.get("post", {})
            author = p.get("author", {})
            record = p.get("record", {})
            posts.append({
                "author": author.get("handle"),
                "text": record.get("text", "")[:300],
                "likes": p.get("likeCount", 0),
                "reposts": p.get("repostCount", 0),
                "replies": p.get("replyCount", 0),
                "created": record.get("createdAt", "")[:16],
                "uri": p.get("uri"),
            })

        return json.dumps(posts, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


@mcp.tool()
def bluesky_get_my_posts(limit: int = 20) -> str:
    """Get your own recent Bluesky posts with engagement metrics."""
    try:
        session = _create_session()
        resp = requests.get(
            f"{BLUESKY_API}/app.bsky.feed.getAuthorFeed",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            params={"actor": session["did"], "limit": min(limit, 50)},
        )
        resp.raise_for_status()
        feed = resp.json().get("feed", [])

        posts = []
        for item in feed:
            p = item.get("post", {})
            record = p.get("record", {})
            posts.append({
                "text": record.get("text", "")[:300],
                "likes": p.get("likeCount", 0),
                "reposts": p.get("repostCount", 0),
                "replies": p.get("replyCount", 0),
                "created": record.get("createdAt", "")[:16],
                "uri": p.get("uri"),
            })

        return json.dumps(posts, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


if __name__ == "__main__":
    mcp.run()
