"""MCP server for Skool — community management via Playwright + public Next.js API."""
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp[cli]", "requests", "playwright"]
# ///

import asyncio
import json
import os
import re
import subprocess
import sys
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

mcp = FastMCP("skool-tools")

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
GROUP_ID = os.environ.get("SKOOL_GROUP_ID", "build-automate")
COOKIE_FILE = Path(__file__).parent.parent / "data" / ".skool-cookies.json"
PYTHON = "python3"


# --- Helpers ---

def _get_nextdata(slug_path: str, group: str = "") -> dict:
    """Fetch data from Skool's Next.js data route (public, no auth needed)."""
    gid = group or GROUP_ID
    resp = requests.get(
        f"https://www.skool.com/{gid}",
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=15,
    )
    html = resp.text

    match = re.search(r'"buildId":"([^"]+)"', html)
    if not match:
        nd_match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html)
        if nd_match:
            nd = json.loads(nd_match.group(1))
            return nd.get("props", {}).get("pageProps", {})
        raise RuntimeError("Could not find Skool buildId")

    build_id = match.group(1)
    data_url = f"https://www.skool.com/_next/data/{build_id}/{gid}{slug_path}.json"

    data_resp = requests.get(
        data_url,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=15,
    )
    return data_resp.json().get("pageProps", {})


async def _playwright_login():
    """Login to Skool via Playwright and save session cookies."""
    from playwright.async_api import async_playwright

    email = os.environ.get("SKOOL_EMAIL")
    password = os.environ.get("SKOOL_PASSWORD")
    if not email or not password:
        raise RuntimeError("SKOOL_EMAIL and SKOOL_PASSWORD must be set in env")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"]
        )
        context = await browser.new_context()
        page = await context.new_page()

        try:
            await page.goto("https://skool.com/login", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(1)
            await page.fill("#email", email)
            await page.fill("#password", password)
            await page.click('button[type="submit"]')
            await asyncio.sleep(4)

            # Verify login succeeded
            if "login" in page.url.lower():
                raise RuntimeError("Login failed — still on login page")

            cookies = await context.cookies()
            COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))
            return cookies
        finally:
            await context.close()
            await browser.close()


async def _get_logged_in_page():
    """Return a Playwright browser, context, and page with a logged-in Skool session.
    Tries saved cookies first; falls back to fresh login."""
    from playwright.async_api import async_playwright

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(
        headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"]
    )
    context = await browser.new_context()

    # Load saved cookies if available
    if COOKIE_FILE.exists():
        cookies = json.loads(COOKIE_FILE.read_text())
        if isinstance(cookies, list) and cookies:
            await context.add_cookies(cookies)

    page = await context.new_page()

    # Test if session is valid by navigating to the group
    await page.goto(
        f"https://www.skool.com/{GROUP_ID}",
        wait_until="domcontentloaded",
        timeout=30000,
    )
    await asyncio.sleep(2)

    # If redirected to login, cookies are stale — do a fresh login
    if "login" in page.url.lower():
        await context.close()
        await browser.close()
        await pw.stop()

        # Fresh login
        await _playwright_login()

        # Re-open with fresh cookies
        pw = await async_playwright().start()
        browser = await pw.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"]
        )
        context = await browser.new_context()
        cookies = json.loads(COOKIE_FILE.read_text())
        await context.add_cookies(cookies)
        page = await context.new_page()
        await page.goto(
            f"https://www.skool.com/{GROUP_ID}",
            wait_until="domcontentloaded",
            timeout=30000,
        )
        await asyncio.sleep(2)

    return pw, browser, context, page


# --- Public tools (no auth) ---

@mcp.tool()
def skool_get_courses(group: str = "") -> str:
    """List all classroom courses with title, description, module count, and access level. Uses public Next.js data — no auth needed. group defaults to your own community; pass a slug like 'skoolers' to browse another."""
    try:
        data = _get_nextdata("/classroom", group=group)
        rd = data.get("renderData", {})
        all_courses = rd.get("allCourses", [])

        courses = []
        for c in all_courses:
            meta = c.get("metadata", {})
            privacy = meta.get("privacy", 0)
            access = {0: "public", 1: "free-members", 2: "paid-only"}.get(privacy, str(privacy))
            courses.append({
                "id": c.get("id"),
                "title": meta.get("title", "<untitled>"),
                "description": meta.get("desc", ""),
                "modules": meta.get("numModules", 0),
                "access": access,
                "created": c.get("createdAt", "")[:10],
                "updated": c.get("updatedAt", "")[:10],
            })

        return json.dumps({"total": len(courses), "courses": courses}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_get_course_detail(course_id: str) -> str:
    """Get full course detail including all modules/lessons with their content. Requires auth (uses Playwright session)."""
    async def _get():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            await page.goto(
                f"https://www.skool.com/{GROUP_ID}/classroom/{course_id}",
                wait_until="domcontentloaded",
                timeout=30000,
            )
            await asyncio.sleep(3)

            data = await page.evaluate("""() => {
                try {
                    const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
                    const pp = nd.props.pageProps;
                    const courseData = pp.course || {};
                    const course = courseData.course || {};
                    const children = courseData.children || [];

                    function parseContent(desc) {
                        if (!desc) return "";
                        if (desc.startsWith("[v2]")) {
                            try {
                                const nodes = JSON.parse(desc.slice(4));
                                function extract(n) {
                                    if (typeof n === "string") return n;
                                    let text = n.text || "";
                                    if (n.content) text += n.content.map(extract).join("");
                                    return text;
                                }
                                return nodes.map(extract).join("\\n").trim();
                            } catch(e) { return desc; }
                        }
                        return desc;
                    }

                    const modules = children.map(child => {
                        const mod = child.course || {};
                        const lessons = (child.children || []).map(l => {
                            const lesson = l.course || l;
                            return {
                                id: lesson.id,
                                title: (lesson.metadata || {}).title || "",
                                content_preview: parseContent((lesson.metadata || {}).desc || "").slice(0, 300),
                            };
                        });
                        return {
                            id: mod.id,
                            title: (mod.metadata || {}).title || (mod.metadata || {}).desc?.slice(0, 100) || "<untitled>",
                            content_preview: parseContent((mod.metadata || {}).desc || "").slice(0, 300),
                            lessons: lessons,
                        };
                    });

                    return {
                        id: course.id,
                        title: (course.metadata || {}).title || "<untitled>",
                        description: (course.metadata || {}).desc || "",
                        modules: modules,
                    };
                } catch(e) { return {error: e.message}; }
            }""")

            return data
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _get()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def skool_get_community(group: str = "") -> str:
    """Get community info: name, description, member count, online users, categories, pricing. Uses public API — no auth needed. group defaults to your own community; pass a slug like 'skoolers' to browse another."""
    try:
        data = _get_nextdata("/about", group=group)
        grp = data.get("currentGroup", {})
        meta = grp.get("metadata", {})

        result = {
            "name": grp.get("name"),
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
                for l in grp.get("labels", [])
            ],
        }
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def skool_get_posts(limit: int = 10, group: str = "") -> str:
    """Get recent community feed posts. Returns title, author, likes, comments, date. Uses public API — no auth needed. group defaults to your own community; pass a slug like 'skoolers' to browse another."""
    try:
        data = _get_nextdata("", group=group)
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


# --- Authenticated tools (Playwright) ---

@mcp.tool()
async def skool_scrape_posts(group: str, limit: int = 30, category: str = "", search: str = "") -> str:
    """Scrape posts from any Skool community you're a member of (including private ones). Uses Playwright with your logged-in session.
    - group: slug (e.g., 'skoolers')
    - category: filter by category display name (e.g., '💎  Gems'). Leave empty for all.
    - search: filter results by keywords (comma-separated). Only posts matching any keyword are returned.
    - limit: max posts per category page (Skool loads ~30 per page)."""
    async def _scrape():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            await page.goto(
                f"https://www.skool.com/{group}",
                wait_until="domcontentloaded",
                timeout=30000,
            )
            await asyncio.sleep(3)

            # If category specified, click it
            if category:
                cat_btn = await page.query_selector(f'button:has-text("{category}")')
                if cat_btn:
                    await cat_btn.click()
                    await asyncio.sleep(3)

            # Scroll to load more posts
            for _ in range(5):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(1.5)

            data = await page.evaluate("""(limit) => {
                try {
                    const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
                    const pp = nd.props.pageProps;
                    const rd = pp.renderData || {};
                    const trees = rd.postTrees || [];
                    const grp = pp.currentGroup || {};
                    const labels = (grp.labels || []).map(l => (l.metadata || {}).displayName || '');
                    const posts = trees.slice(0, limit).map(t => {
                        const p = t.post || {};
                        const meta = p.metadata || {};
                        const user = p.user || {};
                        const uMeta = user.metadata || {};
                        return {
                            title: meta.title || '<no title>',
                            content: (meta.content || '').slice(0, 800),
                            author: uMeta.firstName || user.name || '?',
                            upvotes: meta.upvotes || 0,
                            comments: meta.numComments || 0,
                            pinned: !!meta.pinned,
                            created: (p.createdAt || '').slice(0, 10),
                        };
                    });
                    return { total: rd.total || 0, categories: labels, posts };
                } catch(e) { return { error: e.message }; }
            }""", limit)

            # Client-side keyword filtering
            if search and isinstance(data, dict) and "posts" in data:
                keywords = [k.strip().lower() for k in search.split(",") if k.strip()]
                if keywords:
                    filtered = []
                    for p in data["posts"]:
                        text = (p.get("title", "") + " " + p.get("content", "")).lower()
                        if any(k in text for k in keywords):
                            filtered.append(p)
                    data["posts"] = filtered
                    data["filtered_by"] = keywords

            return data
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _scrape()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_refresh_cookies() -> str:
    """Login to Skool via Playwright and save fresh session cookies. Uses SKOOL_EMAIL and SKOOL_PASSWORD from env."""
    try:
        cookies = await _playwright_login()
        return json.dumps({
            "success": True,
            "cookies_saved": len(cookies),
            "file": str(COOKIE_FILE),
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_create_post(title: str, content: str, category: str = "") -> str:
    """Create a new community post via Skool API + WAF-token bypass (runs fetch inside a logged-in Playwright browser context). Category is the display name (e.g., '⭐ Announcements')."""
    group_hex = os.environ.get("SKOOL_GROUP_HEX_ID", "41f91f47be374a35a94f6c0250f50cc4")

    async def _create():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            # Resolve category display name → label id by scraping the loaded page
            label_id = ""
            if category:
                label_id = await page.evaluate(
                    """(catName) => {
                        try {
                            const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
                            const labels = nd.props.pageProps.currentGroup?.labels || [];
                            const m = labels.find(l => (l.metadata?.displayName || '').trim() === catName.trim());
                            return m ? m.id : '';
                        } catch (e) { return ''; }
                    }""",
                    category,
                )

            body = {
                "group_id": group_hex,
                "post_type": "generic",
                "metadata": {"title": title, "content": content},
            }
            # labels is a single string ID, not an array
            if label_id:
                body["metadata"]["labels"] = label_id
            elif category:
                body["metadata"]["labels"] = category

            # WAF-bypass: call the API from inside the page's JS context so the
            # request inherits the browser's TLS fingerprint + session, and we
            # can grab a valid AwsWafIntegration token.
            result = await page.evaluate(
                """async ({ body }) => {
                    let wafToken = "";
                    try { wafToken = await window.AwsWafIntegration.getToken(); } catch (e) {}
                    const res = await fetch("https://api2.skool.com/posts", {
                        method: "POST",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "x-aws-waf-token": wafToken,
                        },
                        body: JSON.stringify(body),
                    });
                    let text = await res.text();
                    let data;
                    try { data = JSON.parse(text); } catch (e) { data = text; }
                    return { status: res.status, data };
                }""",
                {"body": body},
            )

            # Save refreshed cookies regardless of outcome
            cookies = await context.cookies()
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))

            if result.get("status") == 200 or result.get("status") == 201:
                post = result.get("data") or {}
                slug = post.get("name") or (post.get("metadata") or {}).get("slug")
                url = f"https://www.skool.com/{GROUP_ID}/{slug}" if slug else None
                return {"success": True, "title": title, "status": result["status"], "url": url, "post": post}
            return {"error": "API call failed", "status": result.get("status"), "data": result.get("data"), "label_id_used": label_id}
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _create()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_delete_post(post_id: str) -> str:
    """Delete a community post by its ID (the hex id from create_post response, e.g., '08c4cfdd5e7e4fef9f9af6ef31d533d4')."""
    async def _delete():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            result = await page.evaluate(
                """async (postId) => {
                    let wafToken = "";
                    try { wafToken = await window.AwsWafIntegration.getToken(); } catch (e) {}
                    const res = await fetch(`https://api2.skool.com/posts/${postId}`, {
                        method: "DELETE",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "x-aws-waf-token": wafToken,
                        },
                    });
                    let text = await res.text();
                    let data;
                    try { data = JSON.parse(text); } catch (e) { data = text; }
                    return { status: res.status, data };
                }""",
                post_id,
            )

            cookies = await context.cookies()
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))

            if result.get("status") in (200, 204):
                return {"success": True, "deleted": post_id}
            return {"error": "Delete failed", "status": result.get("status"), "data": result.get("data")}
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _delete()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_pin_post(post_id: str, pinned: bool = True) -> str:
    """Pin or unpin a community post by its ID."""
    async def _pin():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            action_path = "pin" if pinned else "unpin"
            result = await page.evaluate(
                """async ({ postId, actionPath }) => {
                    let wafToken = "";
                    try { wafToken = await window.AwsWafIntegration.getToken(); } catch (e) {}
                    const res = await fetch(`https://api2.skool.com/posts/${postId}/${actionPath}`, {
                        method: "POST",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "x-aws-waf-token": wafToken,
                        },
                    });
                    let text = await res.text();
                    let data;
                    try { data = JSON.parse(text); } catch (e) { data = text; }
                    return { status: res.status, data };
                }""",
                {"postId": post_id, "actionPath": action_path},
            )

            cookies = await context.cookies()
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))

            if result.get("status") == 200:
                return {"success": True, "action": "pin" if pinned else "unpin", "post_id": post_id}
            return {"error": "Pin/unpin failed", "status": result.get("status"), "data": result.get("data")}
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _pin()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_update_lesson(module_id: str, content_json: str) -> str:
    """Update a lesson/module's content in the classroom. module_id is the hex ID of the module. content_json is a JSON string of ProseMirror nodes (array of paragraph/heading/list nodes). The [v2] prefix is added automatically."""
    async def _update():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            # Validate content is valid JSON array
            try:
                nodes = json.loads(content_json)
                if not isinstance(nodes, list):
                    return {"error": "content_json must be a JSON array of ProseMirror nodes"}
            except json.JSONDecodeError as e:
                return {"error": f"Invalid JSON: {e}"}

            desc = "[v2]" + json.dumps(nodes)

            result = await page.evaluate(
                """async ({ moduleId, desc }) => {
                    let wafToken = "";
                    try { wafToken = await window.AwsWafIntegration.getToken(); } catch (e) {}
                    const res = await fetch("https://api2.skool.com/courses/" + moduleId, {
                        method: "PUT",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "x-aws-waf-token": wafToken,
                        },
                        body: JSON.stringify({ desc }),
                    });
                    let text = await res.text();
                    let data;
                    try { data = JSON.parse(text); } catch (e) { data = text; }
                    return { status: res.status, data };
                }""",
                {"moduleId": module_id, "desc": desc},
            )

            cookies = await context.cookies()
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))

            if result.get("status") == 200:
                return {"success": True, "module_id": module_id}
            return {"error": "Update failed", "status": result.get("status"), "data": result.get("data")}
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _update()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_create_course(title: str, description: str = "", access: str = "paid") -> str:
    """Create a new course in the classroom. access: 'public' (0), 'free' (1), or 'paid' (2, default)."""
    group_hex = os.environ.get("SKOOL_GROUP_HEX_ID", "41f91f47be374a35a94f6c0250f50cc4")
    privacy = {"public": 0, "free": 1, "paid": 2}.get(access, 2)

    async def _create():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            result = await page.evaluate(
                """async ({ groupId, title, desc, privacy }) => {
                    let wafToken = "";
                    try { wafToken = await window.AwsWafIntegration.getToken(); } catch (e) {}
                    const res = await fetch("https://api2.skool.com/courses", {
                        method: "POST",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "x-aws-waf-token": wafToken,
                        },
                        body: JSON.stringify({
                            group_id: groupId,
                            unit_type: "course",
                            state: 2,
                            metadata: { title, desc, privacy },
                        }),
                    });
                    let text = await res.text();
                    let data;
                    try { data = JSON.parse(text); } catch (e) { data = text; }
                    return { status: res.status, data };
                }""",
                {"groupId": group_hex, "title": title, "desc": description, "privacy": privacy},
            )

            cookies = await context.cookies()
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))

            if result.get("status") in (200, 201):
                course = result.get("data") or {}
                return {"success": True, "id": course.get("id"), "title": title, "course": course}
            return {"error": "Create course failed", "status": result.get("status"), "data": result.get("data")}
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _create()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_add_module(course_id: str, title: str, content_json: str = "[]") -> str:
    """Add a new module (lesson) to a course. course_id is the parent course hex ID. content_json is optional ProseMirror JSON content (array of nodes)."""
    group_hex = os.environ.get("SKOOL_GROUP_HEX_ID", "41f91f47be374a35a94f6c0250f50cc4")

    async def _add():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            try:
                nodes = json.loads(content_json)
                if not isinstance(nodes, list):
                    return {"error": "content_json must be a JSON array of ProseMirror nodes"}
            except json.JSONDecodeError as e:
                return {"error": f"Invalid JSON: {e}"}

            desc = "[v2]" + json.dumps(nodes) if nodes else ""

            result = await page.evaluate(
                """async ({ groupId, courseId, title, desc }) => {
                    let wafToken = "";
                    try { wafToken = await window.AwsWafIntegration.getToken(); } catch (e) {}
                    const res = await fetch("https://api2.skool.com/courses", {
                        method: "POST",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "x-aws-waf-token": wafToken,
                        },
                        body: JSON.stringify({
                            group_id: groupId,
                            parent_id: courseId,
                            root_id: courseId,
                            unit_type: "module",
                            state: 2,
                            metadata: { title, desc },
                        }),
                    });
                    let text = await res.text();
                    let data;
                    try { data = JSON.parse(text); } catch (e) { data = text; }
                    return { status: res.status, data };
                }""",
                {"groupId": group_hex, "courseId": course_id, "title": title, "desc": desc},
            )

            cookies = await context.cookies()
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))

            if result.get("status") in (200, 201):
                mod = result.get("data") or {}
                return {"success": True, "id": mod.get("id"), "title": title, "module": mod}
            return {"error": "Add module failed", "status": result.get("status"), "data": result.get("data")}
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _add()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
async def skool_delete_course(course_id: str) -> str:
    """Delete a course or module by its hex ID. WARNING: this also deletes all child modules/lessons."""
    async def _delete():
        pw, browser, context, page = await _get_logged_in_page()
        try:
            result = await page.evaluate(
                """async (id) => {
                    let wafToken = "";
                    try { wafToken = await window.AwsWafIntegration.getToken(); } catch (e) {}
                    const res = await fetch("https://api2.skool.com/courses/" + id, {
                        method: "DELETE",
                        credentials: "include",
                        headers: { "x-aws-waf-token": wafToken },
                    });
                    let text = await res.text();
                    let data;
                    try { data = JSON.parse(text); } catch (e) { data = text; }
                    return { status: res.status, data };
                }""",
                course_id,
            )

            cookies = await context.cookies()
            COOKIE_FILE.write_text(json.dumps(cookies, indent=2))

            if result.get("status") == 200:
                return {"success": True, "deleted": course_id}
            return {"error": "Delete failed", "status": result.get("status"), "data": result.get("data")}
        finally:
            await context.close()
            await browser.close()
            await pw.stop()

    try:
        result = await _delete()
        return json.dumps(result, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


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
