"""Minimal binary PLY reader for the Bangudae scan (triangles, xyz + ignored rgb)."""
from __future__ import annotations

import tomllib
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]

VERTEX_DTYPE = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                         ("r", "u1"), ("g", "u1"), ("b", "u1")])
FACE_DTYPE = np.dtype([("n", "u1"), ("i", "<i4", 3)])

EXPECTED_VERTEX_PROPS = [("float", "x"), ("float", "y"), ("float", "z"),
                         ("uchar", "red"), ("uchar", "green"), ("uchar", "blue")]
EXPECTED_FACE_PROPS = [("list uchar int", "vertex_indices")]


def load_config() -> dict:
    with open(REPO / "tools/wall_bake/config.toml", "rb") as f:
        return tomllib.load(f)


def parse_header(raw: bytes) -> dict:
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    lines = raw[:end].decode("ascii").splitlines()
    assert lines[0] == "ply", "not a PLY file"
    header = {"size": end, "format": None, "comments": [], "elements": []}
    for line in lines[1:]:
        parts = line.split()
        if not parts or parts[0] == "end_header":
            continue
        if parts[0] == "format":
            header["format"] = " ".join(parts[1:])
        elif parts[0] == "comment":
            header["comments"].append(" ".join(parts[1:]))
        elif parts[0] == "element":
            header["elements"].append({"name": parts[1], "count": int(parts[2]), "props": []})
        elif parts[0] == "property":
            header["elements"][-1]["props"].append((" ".join(parts[1:-1]), parts[-1]))
    return header


def read_ply(path: Path | None = None) -> tuple[np.ndarray, np.ndarray, dict]:
    """Return (xyz float64 [V,3], faces int32 [F,3], header). Vertex colors are discarded."""
    path = Path(path or REPO / load_config()["paths"]["ply"])
    raw = path.read_bytes()
    header = parse_header(raw)
    assert header["format"] == "binary_little_endian 1.0", header["format"]
    names = [e["name"] for e in header["elements"]]
    assert names == ["vertex", "face"], names
    ev, ef = header["elements"]
    assert ev["props"] == EXPECTED_VERTEX_PROPS, ev["props"]
    assert ef["props"] == EXPECTED_FACE_PROPS, ef["props"]

    nv, nf = ev["count"], ef["count"]
    expected = header["size"] + nv * VERTEX_DTYPE.itemsize + nf * FACE_DTYPE.itemsize
    assert len(raw) == expected, f"size {len(raw)} != {expected}: faces are not all triangles"

    off = header["size"]
    verts = np.frombuffer(raw, VERTEX_DTYPE, nv, off)
    faces = np.frombuffer(raw, FACE_DTYPE, nf, off + nv * VERTEX_DTYPE.itemsize)
    assert np.all(faces["n"] == 3), "non-triangle face"

    xyz = np.stack([verts["x"], verts["y"], verts["z"]], axis=1).astype(np.float64)
    return xyz, faces["i"].astype(np.int32), header
