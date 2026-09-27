"""Step 0: inspect the scan. Prints stats only; writes nothing."""
from __future__ import annotations

import time

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from ply import REPO, load_config, read_ply


def pct(a, qs=(5, 50, 95)):
    return "  ".join(f"p{q}={v:.4g}" for q, v in zip(qs, np.percentile(a, qs)))


def main():
    cfg = load_config()
    t0 = time.time()
    path = REPO / cfg["paths"]["ply"]
    xyz, faces, header = read_ply(path)
    V, F = len(xyz), len(faces)
    print(f"== {path.relative_to(REPO)}  ({path.stat().st_size:,} B, read in {time.time() - t0:.1f}s)")
    print(f"format: {header['format']}   comments: {header['comments']}")
    for e in header["elements"]:
        print(f"element {e['name']} {e['count']:,}: {e['props']}")

    # --- face checks
    print("\n== Faces")
    assert faces.min() >= 0 and faces.max() < V, "index out of range"
    print(f"all triangles, indices in [0, {V})")
    a, b, c = faces.T
    same_idx = (a == b) | (b == c) | (a == c)
    e0, e1 = xyz[b] - xyz[a], xyz[c] - xyz[a]
    cross = np.cross(e0, e1)
    area2 = np.linalg.norm(cross, axis=1)
    zero_area = area2 < 1e-12 * max(1.0, np.median(area2))
    print(f"degenerate: repeated index {same_idx.sum():,}, ~zero area {zero_area.sum():,}")
    used = np.zeros(V, bool)
    used[faces.ravel()] = True
    print(f"unreferenced vertices: {(~used).sum():,}")
    print(f"F - 2V = {F - 2 * V:,}")

    # --- topology
    print("\n== Topology")
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    edges.sort(axis=1)
    key = edges[:, 0].astype(np.int64) * V + edges[:, 1]
    uniq, counts = np.unique(key, return_counts=True)
    print(f"unique edges {len(uniq):,}; used by 1 face (boundary) {np.sum(counts == 1):,}, "
          f"2 faces {np.sum(counts == 2):,}, >2 (non-manifold) {np.sum(counts > 2):,}")
    euler = V - len(uniq) + F
    print(f"Euler characteristic V-E+F = {euler}")
    ncomp, comp = connected_components(
        coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(V, V)), directed=False)
    comp_sizes = np.bincount(comp[used])
    comp_sizes = np.sort(comp_sizes[comp_sizes > 0])[::-1]
    print(f"connected components (by faces): {len(comp_sizes)}; largest {comp_sizes[:5].tolist()} vertices")

    bkey = uniq[counts == 1]
    bnd = np.stack([bkey // V, bkey % V], axis=1)
    if len(bnd):
        bv, inv = np.unique(bnd.ravel(), return_inverse=True)
        be = inv.reshape(-1, 2)
        nl, lab = connected_components(
            coo_matrix((np.ones(len(be)), (be[:, 0], be[:, 1])), shape=(len(bv), len(bv))), directed=False)
        blen = np.linalg.norm(xyz[bnd[:, 0]] - xyz[bnd[:, 1]], axis=1)
        loop_len = np.bincount(lab[be[:, 0]], weights=blen, minlength=nl)
        loop_edges = np.bincount(lab[be[:, 0]], minlength=nl)
        order = np.argsort(loop_len)[::-1]
        print(f"boundary loops: {nl}")
        for i in order[:8]:
            print(f"  loop {i}: {loop_edges[i]:,} edges, length {loop_len[i]:.4g}")
        if nl > 8:
            print(f"  ... {nl - 8} smaller loops, total length {loop_len[order[8:]].sum():.4g}")
        kind = "open (one boundary)" if nl == 1 else f"open with {nl - 1} hole(s)"
    else:
        kind = "closed"
    print(f"=> mesh is {kind}")

    # --- bbox + PCA
    print("\n== Bounding box")
    lo, hi = xyz.min(0), xyz.max(0)
    for ax, l, h in zip("xyz", lo, hi):
        print(f"  {ax}: [{l:.4f}, {h:.4f}]  extent {h - l:.4f}")

    print("\n== PCA (all vertices)")
    mean = xyz.mean(0)
    cov = np.cov((xyz - mean).T)
    evals, evecs = np.linalg.eigh(cov)  # ascending
    for i in (2, 1, 0):
        print(f"  axis {i}: eigval {evals[i]:.5g}  std {np.sqrt(evals[i]):.4g}  dir {np.round(evecs[:, i], 4)}")
    print(f"  smallest/middle eigval ratio: {evals[0] / evals[1]:.4f}")
    normal = evecs[:, 0]
    proj = (xyz - mean) @ evecs
    for i, nm in ((2, "major"), (1, "middle"), (0, "normal")):
        print(f"  extent along {nm} axis: {np.ptp(proj[:, i]):.4f}")

    # --- edge lengths
    print("\n== Edge lengths")
    ue = np.stack([uniq // V, uniq % V], axis=1)
    elen = np.linalg.norm(xyz[ue[:, 0]] - xyz[ue[:, 1]], axis=1)
    print(f"  mesh edges: {pct(elen)}  mean={elen.mean():.4g}")
    rng = np.random.default_rng(cfg["seed"])
    n = min(cfg["inspect"]["nn_patch_vertices"], V)
    # contiguous patch: nearest n vertices to a random used vertex
    tree = cKDTree(xyz)
    center = xyz[rng.choice(np.flatnonzero(used))]
    _, patch = tree.query(center, k=n)
    d, _ = cKDTree(xyz[patch]).query(xyz[patch], k=2)
    print(f"  KD-tree NN on {n:,}-vertex patch: {pct(d[:, 1])}")
    med = np.median(elen)

    # --- face normals vs PCA normal
    print("\n== Face normals vs PCA normal")
    ok = area2 > 0
    fn = cross[ok] / area2[ok, None]
    w = area2[ok] / 2
    cosang = fn @ normal
    side = np.cos(np.radians(cfg["inspect"]["side_on_deg"]))
    fwd, back = cosang > side, cosang < -side
    sidef = ~(fwd | back)
    tot = w.sum()
    print(f"  (area-weighted; side-on = within {90 - cfg['inspect']['side_on_deg']}° of edge-on)")
    print(f"  facing +n: {w[fwd].sum() / tot:6.1%}   count {fwd.sum():,}")
    print(f"  facing -n: {w[back].sum() / tot:6.1%}   count {back.sum():,}")
    print(f"  side-on:   {w[sidef].sum() / tot:6.1%}   count {sidef.sum():,}")
    hist, bins = np.histogram(np.degrees(np.arccos(np.clip(cosang, -1, 1))), bins=18, range=(0, 180), weights=w)
    print("  angle to +n histogram (area %):")
    for lo_, h in zip(bins[:-1], hist / tot):
        print(f"    {lo_:5.0f}-{lo_ + 10:<4.0f} {h:6.2%} {'#' * int(round(h * 100))}")

    print(f"\n== Suggestion\n  mm_per_px ~ median_edge/2 = {med / 2:.4g} (native units; ×1000 if meters)")
    print(f"total time {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
