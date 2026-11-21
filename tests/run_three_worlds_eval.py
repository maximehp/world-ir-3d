"""Live Multi-Domain Evaluation: Three Fundamentally Different Prompts
(Wedding Ceremony, Spaceship Interior, Dense Forest)

Verifies that World IR generates genuinely different environments, spatial layouts,
3D part-tree assemblies, and coordinated human performances — NOT reskinned villages —
and measures:
  1. Streamed cloud generation latencies (TTFV, 1st Object, Geometry Complete, Prov PBR, Refined PBR)
  2. Real-time synchronized GPU frame latency (gl.finish()) in Metal WebGL2
  3. Independent Gemini 4 Hydrogen 4-View Visual & Prompt-Coverage Audit (with matched/missing elements)
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import httpx
import websockets

BASE = "http://127.0.0.1:8000"
CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CDP_PORT = 9231
BENCH_OUT = pathlib.Path(__file__).resolve().parents[1] / "world" / "data" / "benchmarks"
BENCH_OUT.mkdir(parents=True, exist_ok=True)

THREE_PROMPTS = [
    (
        "wedding_ceremony",
        "A romantic sunlit garden wedding ceremony along a floral petal aisle leading to a rose-covered silk ceremony arch, "
        "flanked by rows of wooden guest pews, floral urn pedestals, string fairy lights, a bride in an ivory lace gown and veil "
        "walking down the aisle toward her smiling groom in a black tuxedo, an officiant, seated wedding guests turning to watch, "
        "and white doves circling overhead.",
    ),
    (
        "spaceship_interior",
        "The sleek futuristic command bridge interior of a deep-space exploration starship overlooking a glowing nebula and ringed planet "
        "through a panoramic forward viewport, featuring a central glowing cyan holographic star-map table, an elevated captain command chair, "
        "curved dual helm consoles with luminous status monitors, a pulsing warp core column, structural hull bulkheads, "
        "and uniformed bridge crew officers at their stations.",
    ),
    (
        "dense_forest",
        "A misty primeval dense ancient forest with towering gnarled mossy giant trees and thick overarching canopy, a winding woodland brook, "
        "a massive fallen hollow mossy log, weathered granite boulder outcrops, clusters of giant forest ferns, glowing turquoise bioluminescent mushrooms, "
        "a red fox patrolling the mossy trail, and forest birds darting beneath the boughs.",
    ),
]


class CDPClient:
    def __init__(self, ws_url: str) -> None:
        self.ws_url = ws_url
        self._id = 0

    async def __aenter__(self):
        self.ws = await websockets.connect(self.ws_url, max_size=64 * 1024 * 1024)
        return self

    async def __aexit__(self, *args):
        await self.ws.close()

    async def eval_js(self, expr: str):
        self._id += 1
        cid = self._id
        await self.ws.send(json.dumps({
            "id": cid,
            "method": "Runtime.evaluate",
            "params": {"expression": expr, "awaitPromise": True, "returnByValue": True},
        }))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == cid:
                res = msg.get("result", {})
                if "exceptionDetails" in res:
                    raise RuntimeError(f"JS exception: {res['exceptionDetails']}")
                return res.get("result", {}).get("value")


def stream_world_single(name: str, prompt: str) -> dict:
    t0 = time.perf_counter()
    ops = []
    wid = None
    with httpx.stream("POST", f"{BASE}/api/worlds/stream", json={"prompt": prompt}, timeout=120.0) as r:
        wid = r.headers.get("x-world-id")
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            op = json.loads(line[5:].strip())
            dt = round((time.perf_counter() - t0) * 1000.0, 1)
            ops.append((dt, op["domain"], op["phase"], op["worker"], op["target_id"]))

    w = httpx.get(f"{BASE}/api/worlds/{wid}", timeout=15.0).json()
    carriers: dict[str, int] = {}
    for o in w["objects"]:
        if o["visible"]:
            carriers[o["carrier"]] = carriers.get(o["carrier"], 0) + 1
    humans = [o["id"] for o in w["objects"] if o["visible"] and (o.get("agent") or {}).get("rig_kind") == "human_character"]
    return {
        "name": name,
        "world_id": wid,
        "title": w["title"],
        "ground_kind": w["terrain"].get("ground_kind"),
        "enclosure": w["terrain"].get("enclosure"),
        "plaza_radius": w["terrain"].get("plaza_radius"),
        "space_stars": w["terrain"].get("space_stars"),
        "timings_ms": {
            "ttfv": next((x[0] for x in ops if x[1] == "init"), None),
            "first_obj": next((x[0] for x in ops if x[1] == "object"), None),
            "geo_complete": max((x[0] for x in ops if x[1] == "object"), default=None),
            "first_prov_pbr": next((x[0] for x in ops if x[2] == "texture_provisional"), None),
            "first_master_pbr": next((x[0] for x in ops if x[2] == "texture_refined"), None),
            "total_refined": ops[-1][0] if ops else 0.0,
        },
        "object_count": len([o for o in w["objects"] if o["visible"]]),
        "carriers": carriers,
        "humans": humans,
        "textures": list(w["textures"].keys()),
        "cameras": [c["id"] for c in w["cameras"]],
        "object_names": [o["name"] for o in w["objects"] if o["visible"]],
    }


async def audit_worlds_in_chrome(world_entries: list[dict]) -> list[dict]:
    user_dir = tempfile.mkdtemp(prefix="worldir_eval_")
    proc = subprocess.Popen(
        [
            CHROME_BIN,
            "--headless=new",
            "--enable-webgl",
            "--use-gl=angle",
            "--use-angle=metal",
            "--ignore-gpu-blocklist",
            "--window-size=1440,900",
            f"--remote-debugging-port={CDP_PORT}",
            f"--user-data-dir={user_dir}",
            f"{BASE}/",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(40):
            try:
                tabs = httpx.get(f"http://127.0.0.1:{CDP_PORT}/json", timeout=2.0).json()
                page = next((t for t in tabs if t.get("type") == "page" and "webSocketDebuggerUrl" in t), None)
                if page:
                    ws_url = page["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        assert ws_url, "Chrome CDP failed"

        async with CDPClient(ws_url) as cdp:
            for _ in range(40):
                if await cdp.eval_js("Boolean(window.__WORLD_STUDIO__)"):
                    break
                await asyncio.sleep(0.25)

            for entry in world_entries:
                wid = entry["world_id"]
                res = await cdp.eval_js(f"""(async () => {{
                    const S = window.__WORLD_STUDIO__;
                    const w = await (await fetch('/api/worlds/{wid}')).json();
                    await S.loadFullWorld(w, true);
                    await new Promise(r => setTimeout(r, 850));
                    S.renderAt(1.5, null);
                    const gpu = S.measureSyncGpuFrameMs(20);
                    const auditRes = await S.runHydrogen4ViewAudit(false);
                    return {{ gpu, verdict: auditRes.verdict }};
                }})()""")
                entry["gpu"] = res["gpu"]
                entry["hydrogen_audit"] = res["verdict"]
        return world_entries
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def main() -> None:
    entries = []
    for name, prompt in THREE_PROMPTS:
        print(f"\n=== STREAMING SINGLE-WORLD TEST: {name.upper()} ===")
        e = stream_world_single(name, prompt)
        print(f"  world_id={e['world_id']} | title='{e['title']}'")
        print(f"  env: ground_kind={e['ground_kind']} | enclosure={e['enclosure']} | plaza_r={e['plaza_radius']} | stars={e['space_stars']}")
        print(f"  timings_ms: {e['timings_ms']}")
        print(f"  objects ({e['object_count']}): carriers={e['carriers']} | humans={e['humans']}")
        print(f"  names: {e['object_names']}")
        entries.append(e)

    print("\n=== RUNNING METAL-WEBGL2 4-VIEW HYDROGEN PROMPT-COVERAGE AUDITS ===")
    entries = asyncio.run(audit_worlds_in_chrome(entries))
    for e in entries:
        v = e["hydrogen_audit"]
        print(f"\n  [{e['name'].upper()} / {e['world_id']}]")
        print(f"    GPU: {e['gpu']['mean_ms']}ms ({e['gpu']['effective_fps']} FPS) | Plate: {v['multiview_plate_url']}")
        print(f"    Hydrogen Audit: {v['status']} | 3DGeo={v['geometry_3d_score']} | Spatial={v['spatial_coherence_score']} | Lighting={v['lighting_material_score']} | PromptCoverage={v['prompt_coverage_score']}")
        print(f"    Matched: {v.get('matched_elements')}")
        print(f"    Missing: {v.get('missing_elements')}")
        print(f"    Summary: {v['summary']}")

    out_path = BENCH_OUT / "three_domains_report.json"
    out_path.write_text(json.dumps(entries, indent=2))
    print(f"\nSAVED THREE-DOMAINS REPORT: {out_path}")


if __name__ == "__main__":
    main()
