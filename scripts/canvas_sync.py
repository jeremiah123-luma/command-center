#!/usr/bin/env python3
"""Pull Canvas planner items (with submission status) and POST the snapshot to the Command Center worker.
Env: CANVAS_TOKEN, INGEST_URL (https://.../api/canvas/ingest), INGEST_SECRET. Optional CANVAS_BASE."""
import json, os, re, sys, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone
BASE = os.environ.get("CANVAS_BASE", "https://njit.instructure.com") + "/api/v1"
TOKEN = os.environ["CANVAS_TOKEN"]
HDR = {"Authorization": f"Bearer {TOKEN}", "User-Agent": "CommandCenter-sync/1.0", "Accept": "application/json"}
def get(path, **params):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params, doseq=True)}"; out = []
    while url:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HDR), timeout=30) as r:
            data = json.load(r); out.extend(data if isinstance(data, list) else [data])
            m = re.search(r'<([^>]+)>;\s*rel="next"', r.headers.get("Link", "")); url = m.group(1) if m else None
    return out
def short_code(code, name):
    c = re.sub(r"^[A-Z]{2}\d{2}-", "", code or ""); m = re.match(r"^([A-Z]{2,5})(\d{3}[A-Z]?)", c)
    if m: return f"{m.group(1)} {m.group(2)}"
    if c.startswith("FYS"): return "FYS"
    if "Commons" in (name or ""): return "PHYS 111 Commons"
    return c or (name or "")[:14]
now = datetime.now(timezone.utc)
start = (now - timedelta(days=7)).strftime("%Y-%m-%dT00:00:00Z"); end = (now + timedelta(days=35)).strftime("%Y-%m-%dT00:00:00Z")
courses = {c["id"]: c for c in get("/courses", enrollment_state="active", per_page=100)}
planner = get("/planner/items", start_date=start, end_date=end, per_page=100)
# score per assignment. submission_type "external_tool" = homework that passes its score back as you work
# (Mastering, zyBooks): Canvas calls it "submitted" at 5.5/11, so the dashboard shows it as in progress until due.
scores, progressive = {}, set()
for cid in courses:
    try:
        for sub in get(f"/courses/{cid}/students/submissions", per_page=100, **{"student_ids[]": "self"}):
            aid = sub.get("assignment_id")
            if aid is None: continue
            scores[aid] = sub.get("score")
            if sub.get("submission_type") == "external_tool": progressive.add(aid)
    except Exception: pass
GRADED = {"assignment", "quiz", "discussion_topic", "wiki_page"}; seen, items = set(), []
for it in planner:
    if it.get("plannable_type") not in GRADED: continue
    p = it.get("plannable") or {}; s = it.get("submissions"); s = s if isinstance(s, dict) else {}
    c = courses.get(it.get("course_id"), {}); pid = p.get("id") or it.get("plannable_id"); iid = f"{it['plannable_type']}-{pid}"
    if iid in seen: continue
    seen.add(iid)
    items.append({"id": iid, "type": it["plannable_type"], "courseId": it.get("course_id"), "course": short_code(c.get("course_code"), c.get("name")),
        "courseName": c.get("name") or it.get("context_name"), "title": (p.get("title") or "").strip(), "dueAt": p.get("due_at") or it.get("plannable_date"),
        "points": p.get("points_possible"), "submitted": bool(s.get("submitted")), "graded": bool(s.get("graded")), "excused": bool(s.get("excused")),
        "late": bool(s.get("late")), "missing": bool(s.get("missing")),
        "score": scores.get(pid) if it["plannable_type"] == "assignment" else None, "progressive": it["plannable_type"] == "assignment" and pid in progressive, "url": BASE.replace("/api/v1", "") + (it.get("html_url") or "")})
items.sort(key=lambda x: x["dueAt"] or "")
snap = {"updatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "items": items,
        "courses": [{"id": cid, "code": short_code(c.get("course_code"), c.get("name")), "name": c.get("name")} for cid, c in courses.items()],
        "counts": {"open": sum(1 for x in items if not x["submitted"] and not x["excused"]), "submitted": sum(1 for x in items if x["submitted"])}}
if os.environ.get("INGEST_URL"):
    req = urllib.request.Request(os.environ["INGEST_URL"], data=json.dumps(snap).encode(), method="POST",
          headers={"content-type": "application/json", "user-agent": "CommandCenter-sync/1.0", "x-ingest-secret": os.environ["INGEST_SECRET"]})
    with urllib.request.urlopen(req, timeout=30) as r: print("ingest:", r.status, r.read().decode()[:120])
else:
    json.dump(snap, sys.stdout, indent=1)
print(f"synced {len(items)} items, {snap['counts']['open']} open", file=sys.stderr)
