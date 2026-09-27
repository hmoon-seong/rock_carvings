"""Color conversions and the lighting model contract (numpy mirror of the web GLSL).

See "Lighting model contract" in WALL_BAKE.md. All shading happens in linear RGB;
sRGB encode happens once at the end.
"""
from __future__ import annotations

import numpy as np

# Placeholder defaults, fitted in Step 8.
DEFAULT_LIGHTING = {
    "sun_color": [1.0, 0.96, 0.90],
    "sky_color": [0.42, 0.45, 0.52],
    "ground_color": [0.30, 0.26, 0.24],
    "photo_azimuth_deg": 315.0,   # light from upper-left
    "photo_elevation_deg": 45.0,
    "detail_strength": 1.0,
}

_M_RGB2XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                       [0.2126729, 0.7151522, 0.0721750],
                       [0.0193339, 0.1191920, 0.9503041]])
_M_XYZ2RGB = np.linalg.inv(_M_RGB2XYZ)
_WHITE = np.array([0.95047, 1.0, 1.08883])


def srgb_to_linear(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, np.float64), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def linear_to_lab(rgb):
    xyz = rgb @ _M_RGB2XYZ.T / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def lab_to_linear(lab):
    lab = np.asarray(lab, np.float64)
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], axis=-1)
    xyz = np.where(f > 0.206893, f ** 3, (f - 16 / 116) / 7.787) * _WHITE
    return np.clip(xyz @ _M_XYZ2RGB.T, 0, None)


def luminance(rgb_lin):
    return rgb_lin @ _M_RGB2XYZ[1]


def to_u8(srgb):
    return (np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)


def encode_normal(n):
    """float normals [...,3] -> uint8 rgb, OpenGL convention (+Y up)."""
    return to_u8(n * 0.5 + 0.5)


def decode_normal(img):
    n = np.asarray(img, np.float64)[..., :3] / 255.0 * 2 - 1
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def light_dir(azimuth_deg, elevation_deg):
    """Azimuth 0 = light from image top (+Y), 90 = from the right (+X). Elevation above the wall plane."""
    az, el = np.radians(azimuth_deg), np.radians(elevation_deg)
    return np.array([np.sin(az) * np.cos(el), np.cos(az) * np.cos(el), np.sin(el)])


def _normalize(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def shade(n_base, albedo_lin, ao, L, *, n_detail=None, detail_strength=0.0, n_carve=None,
          sun_color=None, sky_color=None, ground_color=None):
    """The contract, line for line. Returns linear RGB."""
    d = DEFAULT_LIGHTING
    sun = np.asarray(sun_color or d["sun_color"])
    sky = np.asarray(sky_color or d["sky_color"])
    ground = np.asarray(ground_color or d["ground_color"])
    n = n_base
    if n_detail is not None:
        n = _normalize(np.concatenate([n[..., :2] + detail_strength * n_detail[..., :2], n[..., 2:]], -1))
    if n_carve is not None:
        n = _normalize(np.concatenate([n[..., :2] + n_carve[..., :2], n[..., 2:]], -1))
    diffuse = np.maximum(n @ np.asarray(L), 0)[..., None]
    t = (n[..., 1:2] * 0.5 + 0.5)
    ambient = (ground * (1 - t) + sky * t) * np.asarray(ao)[..., None]
    return albedo_lin * (sun * diffuse + ambient)
