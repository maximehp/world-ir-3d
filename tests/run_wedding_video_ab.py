"""Reproducible End-to-End Appearance-Anchored Wedding Video A/B Experiment.

Runs against the live WorldIR 3D Studio (http://127.0.0.1:8000) via Headless Chrome
with native Metal WebGL2:
  1. Probes Gemini API for native video models (explicitly recording availability/limits).
  2. Loads deterministic 3D Courtyard Wedding Benchmark (`w3d_wedding_bench`) and verifies
     bit-exact timestamp reproducibility + synchronized GPU frame latency.
  3. Captures 7 sequential 16:9 keyframes (RGB + Depth + Normals + Object-ID), 97 dense 24 FPS
     3D guide frames, and 3-view canonical studio turnarounds (Front / 3/4 Side / Back) for
     Bride & Groom.
  4. Generates Persistent Scene Reference + Canonical Bride & Groom References IN PARALLEL.
  5. Generates REAL 24 FPS H.264 MP4 videos for BOTH controlled conditions IN PARALLEL:
       - Video A (`structural_only.mp4`): 3D RGB + G-Buffer structural guidance alone
       - Video B (`appearance_anchored.mp4`): 3D RGB + G-Buffer + Persistent Scene/Entity Refs + Temporal Anchor
     plus synchronized 3-panel comparison video (`comparison_3up.mp4`).
  6. Evaluates BOTH decoded MP4s quantitatively (Temporal Warp PSNR/L1, Exposure Drift,
     Edge F1, Object-Silhouette Recall, 3D Motion-Flow Correlation) + independent Gemini 4
     Hydrogen multimodal video audit.
  7. Verifies incremental edit cache locality: surgically edits ONLY the bride's dress and
     proves `scene` & `groom` refs hit cache (0 calls) while ONLY `bride` regenerates (1 call).
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import httpx
import numpy as np
import websockets
from PIL import Image

from world.video_pipeline import (
    _make_horizontal_strip,
    build_side_by_side_comparison_mp4,
    decode_mp4_frames,
    hydrogen_audit_video_ab,
    probe_video_model_support,
)

BASE = "http://127.0.0.1:8000"
CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CDP_PORT = 9229
OUT_ROOT = pathlib.Path(__file__).resolve().parents[1] / "world" / "data" / "worlds" / "w3d_wedding_bench"


class CDPClient:
    def __init__(self, ws_url: str) -> None:
        self.ws_url = ws_url
        self._id = 0

    async def __aenter__(self):
        self.ws = await websockets.connect(self.ws_url, max_size=128 * 1024 * 1024)
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


def _b64_to_np(b64: str) -> np.ndarray:
    raw = b64.split(",", 1)[-1]
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB"))


async def _capture_from_studio(world_id: str, reset_wedding: bool = True):
    user_dir = tempfile.mkdtemp(prefix="worldir_cdp_")
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
        assert ws_url, "Failed to attach to headless Chrome CDP"

        async with CDPClient(ws_url) as cdp:
            # Wait for studio JS bootstrap
            for _ in range(40):
                ready = await cdp.eval_js("Boolean(window.__WORLD_STUDIO__)")
                if ready:
                    break
                await asyncio.sleep(0.25)

            setup = await cdp.eval_js(f"""(async () => {{
                const S = window.__WORLD_STUDIO__;
                const w = await (await fetch('{'/api/worlds/wedding-benchmark' if reset_wedding else f'/api/worlds/{world_id}'}', {{
                    method: '{'POST' if reset_wedding else 'GET'}'
                }})).json();
                await S.loadFullWorld(w, true);
                // Ensure canonical 16:9 framing keeping both Bride and Groom clearly centered across all 4.5s
                const dolly = S.state.world.cameras.find(c => c.id === 'wedding_dolly_arc');
                if (dolly) {{
                    dolly.keyframes = [
                        {{ t: 0.0, pos: [1.6, 2.0, 7.6], look_at: [-0.05, 1.25, 0.2], fov_deg: 48.0 }},
                        {{ t: 1.5, pos: [2.5, 1.9, 4.6], look_at: [-0.05, 1.28, -1.8], fov_deg: 46.0 }},
                        {{ t: 3.0, pos: [2.7, 1.85, 1.5], look_at: [0.05, 1.32, -3.7], fov_deg: 44.0 }},
                        {{ t: 4.5, pos: [2.1, 1.75, -0.6], look_at: [0.12, 1.35, -5.0], fov_deg: 42.0 }},
                    ];
                }}
                // Wait for async PBR texture images to finish decoding
                await new Promise(r => setTimeout(r, 900));

                // Verify deterministic timestamp reproducibility
                const fA = S.renderAt(2.25, 'wedding_dolly_arc');
                const fOther = S.renderAt(4.0, 'crane_ceremony_wide');
                const fB = S.renderAt(2.25, 'wedding_dolly_arc');
                const gpu = S.measureSyncGpuFrameMs(24);

                const timestamps = [0.0, 0.75, 1.5, 2.25, 3.0, 3.75, 4.5];
                const keyframes = S.captureShotKeyframes('wedding_dolly_arc', timestamps, 768, 480);
                const brideViews = S.captureEntityTurnaround3View('bride');
                const groomViews = S.captureEntityTurnaround3View('groom');
                const denseGuide = S.captureDenseGuideFrames('wedding_dolly_arc', 0.0, 4.5, 97, 480, 300);

                return {{
                    deterministic_identical: fA === fB,
                    gpu,
                    keyframes,
                    brideViews,
                    groomViews,
                    denseGuide,
                }};
            }})()""")
            return setup
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def main() -> None:
    print("=== 1. PROBING GEMINI VIDEO MODEL CAPABILITIES ===")
    caps = probe_video_model_support()
    print(json.dumps(caps, indent=2))

    print("\n=== 2. CAPTURING DETERMINISTIC 3D WEDDING SHOT & ENTITY TURNAROUNDS VIA METAL WEBGL2 ===")
    cap = asyncio.run(_capture_from_studio("w3d_wedding_bench", reset_wedding=True))
    print(f"  Deterministic timestamp identical: {cap['deterministic_identical']}")
    print(f"  Synchronized GPU frame time:       {cap['gpu']}")
    print(f"  Captured: {len(cap['keyframes'])} G-Buffer keyframes + {len(cap['denseGuide'])} dense 24fps guide frames + Bride/Groom 3-view turnarounds")

    vid_dir = OUT_ROOT / "videos"
    vid_dir.mkdir(parents=True, exist_ok=True)
    # Save 3D guide strip for visual inspection & audit
    guide_pils = [Image.fromarray(_b64_to_np(f["rgb"])) for f in cap["keyframes"]]
    guide_strip = _make_horizontal_strip(guide_pils, 320, 200)
    guide_strip_path = vid_dir / "guide_3d_keyframes_strip.jpg"
    guide_strip.save(guide_strip_path, quality=92)

    print("\n=== 3. GENERATING PERSISTENT APPEARANCE REFERENCES IN PARALLEL (SCENE + BRIDE + GROOM) ===")
    ref_resp = httpx.post(
        f"{BASE}/api/worlds/w3d_wedding_bench/appearance-refs",
        json={
            "scene_guide": cap["keyframes"][1],
            "entity_guides": {"bride": cap["brideViews"], "groom": cap["groomViews"]},
            "force": True,
        },
        timeout=120.0,
    )
    ref_resp.raise_for_status()
    ref_data = ref_resp.json()
    print(f"  Parallel Refs Info: {json.dumps(ref_data['refs_info'], indent=2)}")

    shot_desc = (
        "Golden-hour sunlit Tuscan courtyard wedding ceremony: the bride in her ivory silk lace A-line gown "
        "and flowing sheer cathedral veil walks gracefully down the cobblestone aisle holding a white-and-blush rose bouquet "
        "toward her smiling groom in a black tuxedo waiting beneath the stone archway, watched by guests, "
        "as the cinema camera smoothly glides forward along a curved right-side dolly arc."
    )

    print("\n=== 4. GENERATING REAL 24 FPS H.264 MP4 VIDEOS IN PARALLEL (A: STRUCTURAL ONLY vs B: APPEARANCE-ANCHORED) ===")
    def _gen_vid(mode: str) -> dict:
        r = httpx.post(
            f"{BASE}/api/worlds/w3d_wedding_bench/generate-video",
            json={
                "keyframes": cap["keyframes"],
                "shot_description": shot_desc,
                "mode": mode,
                "hero_entity_ids": ["bride", "groom"],
                "fps": 24,
                "subframes_per_interval": 16,
            },
            timeout=180.0,
        )
        r.raise_for_status()
        return r.json()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        fa = pool.submit(_gen_vid, "structural_only")
        fb = pool.submit(_gen_vid, "appearance_anchored")
        vid_a = fa.result()
        vid_b = fb.result()

    print(f"\n  VIDEO A (Structural Only):      {vid_a['mp4_url']} ({vid_a['duration_s']}s @ {vid_a['fps']}fps)")
    print(f"    Timings: {vid_a['timings']}")
    print(f"    Metrics: {vid_a['metrics']}")
    print(f"\n  VIDEO B (Appearance-Anchored):  {vid_b['mp4_url']} ({vid_b['duration_s']}s @ {vid_b['fps']}fps)")
    print(f"    Timings: {vid_b['timings']}")
    print(f"    Metrics: {vid_b['metrics']}")

    print("\n=== 5. BUILDING SYNCHRONIZED 3-PANEL COMPARISON MP4 & RUNNING GEMINI 4 HYDROGEN VIDEO AUDIT ===")
    dense_np = [_b64_to_np(b) for b in cap["denseGuide"]]
    comp_mp4 = vid_dir / "comparison_3up.mp4"
    build_side_by_side_comparison_mp4(
        dense_np,
        pathlib.Path(vid_a["mp4_path"]),
        pathlib.Path(vid_b["mp4_path"]),
        comp_mp4,
        fps=24,
    )
    print(f"  Saved synchronized 3-panel comparison MP4: {comp_mp4} ({comp_mp4.stat().st_size // 1024} KB)")

    # Extract 7 evenly spaced frames DIRECTLY from BOTH decoded MP4 files for honest audit
    dec_a = decode_mp4_frames(pathlib.Path(vid_a["mp4_path"]))
    dec_b = decode_mp4_frames(pathlib.Path(vid_b["mp4_path"]))
    idxs = [min(i * 16, len(dec_a) - 1) for i in range(7)]
    strip_a = _make_horizontal_strip([Image.fromarray(dec_a[i]) for i in idxs], 320, 200)
    strip_b = _make_horizontal_strip([Image.fromarray(dec_b[i]) for i in idxs], 320, 200)

    # Stacked visual comparison sheet for direct inspection
    sheet = Image.new("RGB", (320 * 7, 200 * 3 + 72), (14, 18, 26))
    sheet.paste(guide_strip, (0, 24))
    sheet.paste(strip_a, (0, 248))
    sheet.paste(strip_b, (0, 472))
    ab_sheet_path = vid_dir / "ab_comparison_sheet.jpg"
    sheet.save(ab_sheet_path, quality=92)

    refs_dict = ref_data["world"]["appearance_refs"]
    ref_imgs = []
    for k in ("scene", "bride", "groom"):
        if k in refs_dict:
            p = OUT_ROOT / "refs" / pathlib.Path(refs_dict[k]["image_url"]).name
            if p.exists():
                ref_imgs.append(Image.open(p).convert("RGB"))

    audit, audit_ms = hydrogen_audit_video_ab(guide_strip, strip_a, strip_b, ref_imgs, shot_desc)
    print(f"  Hydrogen Video Audit ({audit_ms:.0f} ms): winner={audit.winner}")
    print(f"    Video A (Structural Only):     photo={audit.structural_only_photorealism} | id={audit.structural_only_identity_consistency} | motion={audit.structural_only_motion_fidelity} | temp={audit.structural_only_temporal_stability}")
    print(f"    Video B (Appearance-Anchored): photo={audit.anchored_photorealism} | id={audit.anchored_identity_consistency} | motion={audit.anchored_motion_fidelity} | temp={audit.anchored_temporal_stability}")
    print(f"    Summary: {audit.summary}")
    for obs in audit.specific_observations:
        print(f"      - {obs}")

    print("\n=== 6. INCREMENTAL EDIT CACHE VERIFICATION (EDIT ONLY BRIDE DRESS -> CHECK CACHE HITS) ===")
    te = time.perf_counter()
    ttfc = None
    edit_delta = {}
    with httpx.stream(
        "POST",
        f"{BASE}/api/worlds/w3d_wedding_bench/edit/stream",
        json={"instruction": "Change the bride's wedding dress color to romantic blush rose pink silk with delicate champagne gold accents."},
        timeout=60.0,
    ) as er:
        for line in er.iter_lines():
            if not line.startswith("data:"):
                continue
            op = json.loads(line[5:].strip())
            if op.get("phase") == "edit" and ttfc is None and op.get("domain") != "status":
                ttfc = round((time.perf_counter() - te) * 1000, 1)
            if op.get("domain") == "status" and op.get("action") == "complete":
                edit_delta = op["payload"].get("delta", {})
    edit_tot = round((time.perf_counter() - te) * 1000, 1)
    print(f"  Dress Edit: TTFC={ttfc}ms | Total={edit_tot}ms | changed={edit_delta.get('changed_object_ids')}")

    # Re-capture ONLY after dress edit & call appearance-refs with force=False!
    cap2 = asyncio.run(_capture_from_studio("w3d_wedding_bench", reset_wedding=False))
    ref_resp2 = httpx.post(
        f"{BASE}/api/worlds/w3d_wedding_bench/appearance-refs",
        json={
            "scene_guide": cap2["keyframes"][1],
            "entity_guides": {"bride": cap2["brideViews"], "groom": cap2["groomViews"]},
            "force": False,
        },
        timeout=120.0,
    )
    ref_resp2.raise_for_status()
    ref_data2 = ref_resp2.json()
    print(f"  Incremental Ref Update: {json.dumps(ref_data2['refs_info'], indent=2)}")
    assert "scene" in ref_data2["refs_info"]["cache_hits"], "Scene ref should be cached (0 calls)!"
    assert "groom" in ref_data2["refs_info"]["cache_hits"], "Groom ref should be cached (0 calls)!"
    assert "bride" in ref_data2["refs_info"]["regenerated"], "Bride ref should regenerate after dress edit!"
    print("  [VERIFIED] Incremental cache locality: scene=HIT (0 calls), groom=HIT (0 calls), bride=REGENERATED (1 call)!")

    report = {
        "video_api_capabilities": caps,
        "deterministic_reproducibility": cap["deterministic_identical"],
        "realtime_gpu": cap["gpu"],
        "initial_refs": ref_data["refs_info"],
        "video_a_structural_only": vid_a,
        "video_b_appearance_anchored": vid_b,
        "comparison_3up_mp4": str(comp_mp4),
        "ab_comparison_sheet": str(ab_sheet_path),
        "hydrogen_video_audit": audit.model_dump(),
        "hydrogen_audit_ms": round(audit_ms, 1),
        "incremental_dress_edit": {
            "ttfc_ms": ttfc,
            "total_ms": edit_tot,
            "changed_ids": edit_delta.get("changed_object_ids", []),
            "refs_update": ref_data2["refs_info"],
        },
    }
    report_path = OUT_ROOT / "videos" / "wedding_ab_report.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(f"\nSAVED FULL REPORT: {report_path}")


if __name__ == "__main__":
    main()
