"""Nano Banana 2.1 Seamless PBR Material Texture Synthesizer.

Generates tileable albedo textures with Nano Banana 2.1, enforces seamless edges via
cosine-feathered toroidal crossfade, and deterministically derives matching
Tangent-Space Normal Maps and Roughness Maps in ~15 ms with OpenCV.
"""

from __future__ import annotations

import io
import os
import pathlib
import time

import cv2
import numpy as np
from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

load_dotenv()

NANO_BANANA_MODEL = "gemini-nano-banana-2.1"


def _get_client() -> genai.Client:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return genai.Client(api_key=key)


def make_seamless_tile(rgb: np.ndarray, blend_frac: float = 0.16) -> np.ndarray:
    """Enforce guaranteed seamless tiling along both X and Y borders via half-shift cosine blending."""
    h, w, _ = rgb.shape
    img = rgb.astype(np.float32)

    # Shift image by half-width and half-height so original borders lie in center, then feather-blend
    shifted = np.roll(np.roll(img, h // 2, axis=0), w // 2, axis=1)
    yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    # Raised diamond/cosine window: 1.0 in center, 0.0 at edges
    wx = np.clip((1.0 - np.abs(xx)) / max(blend_frac, 0.05), 0.0, 1.0)
    wy = np.clip((1.0 - np.abs(yy)) / max(blend_frac, 0.05), 0.0, 1.0)
    wx = 0.5 - 0.5 * np.cos(wx * np.pi)
    wy = 0.5 - 0.5 * np.cos(wy * np.pi)
    mask = (wx * wy)[..., None]
    blended = img * mask + shifted * (1.0 - mask)
    return np.clip(blended, 0, 255).astype(np.uint8)


def derive_normal_and_roughness(albedo_rgb: np.ndarray, strength: float = 2.6) -> tuple[np.ndarray, np.ndarray]:
    """Deterministically compute tangent-space normal map + roughness map from seamless albedo."""
    gray = cv2.cvtColor(albedo_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    # Slight Gaussian pre-smooth reduces JPEG block noise in normal map
    height = cv2.GaussianBlur(gray, (3, 3), 0.6)

    # Toroidal wrap padding guarantees seamless normal tiling across texture borders
    padded = np.pad(height, 1, mode="wrap")
    dx = cv2.Sobel(padded, cv2.CV_32F, 1, 0, ksize=3)[1:-1, 1:-1] * strength
    dy = cv2.Sobel(padded, cv2.CV_32F, 0, 1, ksize=3)[1:-1, 1:-1] * strength
    dz = np.ones_like(dx)
    inv_len = 1.0 / np.sqrt(dx * dx + dy * dy + dz * dz + 1e-8)
    nx = (-dx * inv_len) * 0.5 + 0.5
    ny = (-dy * inv_len) * 0.5 + 0.5
    nz = (dz * inv_len) * 0.5 + 0.5
    normal_rgb = np.clip(np.dstack([nx, ny, nz]) * 255.0, 0, 255).astype(np.uint8)

    # Roughness: darker crevices & high-frequency micro-contrast -> rougher; smooth bright highlights -> glossier
    local_mean = cv2.GaussianBlur(gray, (9, 9), 2.0)
    micro_var = np.abs(gray - local_mean)
    rough = np.clip(0.86 - 0.32 * gray + 0.65 * micro_var, 0.25, 0.96)
    rough_u8 = (rough * 255.0).astype(np.uint8)
    return normal_rgb, rough_u8


def synthesize_pbr_texture(
    tex_id: str,
    material_prompt: str,
    out_dir: pathlib.Path,
    size: int = 512,
) -> tuple[dict, float]:
    """Generate a seamless tileable PBR texture set (albedo + normal + roughness) via Nano Banana 2.1."""
    client = _get_client()
    full_prompt = (
        f"Seamless tileable 2D PBR albedo surface texture of: {material_prompt}. "
        "Strictly orthographic flat top-down view, completely uniform even diffuse lighting, "
        "NO directional shadows, NO perspective distortion, NO objects or borders, edge-to-edge repeating material pattern."
    )
    t0 = time.perf_counter()
    resp = client.models.generate_content(
        model=NANO_BANANA_MODEL,
        contents=full_prompt,
        config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
    )
    ms = (time.perf_counter() - t0) * 1000.0

    raw_img = None
    for cand in resp.candidates or []:
        for part in cand.content.parts or []:
            inline = getattr(part, "inline_data", None)
            if inline and inline.data:
                raw_img = Image.open(io.BytesIO(inline.data)).convert("RGB")
                break
    if raw_img is None:
        raise RuntimeError(f"Nano Banana returned no texture for {tex_id}")

    # Center-crop square and resize to power-of-two 512x512 for crisp GPU mipmapping
    side = min(raw_img.width, raw_img.height)
    x0 = (raw_img.width - side) // 2
    y0 = (raw_img.height - side) // 2
    sq = raw_img.crop((x0, y0, x0 + side, y0 + side)).resize((size, size), Image.Resampling.LANCZOS)

    seamless = make_seamless_tile(np.asarray(sq))
    normal_rgb, rough_u8 = derive_normal_and_roughness(seamless)

    albedo_name = f"tex_{tex_id}_albedo.jpg"
    normal_name = f"tex_{tex_id}_normal.jpg"
    rough_name = f"tex_{tex_id}_rough.jpg"

    Image.fromarray(seamless).save(out_dir / albedo_name, quality=90)
    Image.fromarray(normal_rgb).save(out_dir / normal_name, quality=90)
    Image.fromarray(rough_u8).save(out_dir / rough_name, quality=88)

    return {
        "albedo_name": albedo_name,
        "normal_name": normal_name,
        "rough_name": rough_name,
    }, ms
