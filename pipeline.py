"""
pipeline.py — the image-processing side of the hair studio web app.

    segment(image)  -> hair/face masks, a strand-flow texture and head geometry
    make_plate(image, hair_mask) -> the photo with the hair painted out (LaMa),
                                    used as the backdrop when hair is cut/restyled

All colouring and restyling happens live in the browser (static/js/renderer.js);
this module only produces the textures the shader needs.
"""

import threading
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODELS = Path(__file__).parent / "models"
SEG_MODEL = MODELS / "selfie_multiclass_256x256.tflite"
LAMA_MODEL = MODELS / "lama_fp32.onnx"

# selfie_multiclass labels: 0 bg, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 other
HAIR, FACE = 1, 3

_seg_lock = threading.RLock()
_segmenter = None
_lama_lock = threading.RLock()
_lama = None


# ---------------------------------------------------------------- segmentation

def _get_segmenter():
    global _segmenter
    with _seg_lock:
        if _segmenter is not None:
            return _segmenter
        options = vision.ImageSegmenterOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(SEG_MODEL)),
            output_category_mask=False,
            output_confidence_masks=True,
        )
        _segmenter = vision.ImageSegmenter.create_from_options(options)
        return _segmenter


def _run_model(image_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Raw hair and face confidence maps at the image's resolution."""
    rgb = np.ascontiguousarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
    with _seg_lock:
        result = _get_segmenter().segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    h, w = image_bgr.shape[:2]
    out = []
    for cls in (HAIR, FACE):
        m = result.confidence_masks[cls].numpy_view().astype(np.float32)
        if m.shape[:2] != (h, w):
            m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
        out.append(m)
    return out[0], out[1]


def _bbox(mask: np.ndarray, thresh: float):
    ys, xs = np.nonzero(mask > thresh)
    if len(xs) < 50:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _guided_filter(guide: np.ndarray, src: np.ndarray, r: int, eps: float) -> np.ndarray:
    """Edge-aware upsampling of the low-res model mask onto real strand edges (He et al.)."""
    k = (2 * r + 1, 2 * r + 1)
    mean = lambda x: cv2.boxFilter(x, -1, k, borderType=cv2.BORDER_REFLECT)
    mI, mp_ = mean(guide), mean(src)
    a = (mean(guide * src) - mI * mp_) / (mean(guide * guide) - mI * mI + eps)
    b = mp_ - a * mI
    return mean(a) * guide + mean(b)


def _strand_textures(gray: np.ndarray, hair: np.ndarray, seed: int) -> np.ndarray:
    """
    Two noise maps smeared along the local hair direction (line integral convolution),
    so highlights / babylights in the shader follow the real strands.
    Returns uint8 H×W×3: R = fine streaks, G = chunky streaks, B = strand direction x (0.5 = vertical).
    """
    h, w = gray.shape
    scale = max(h, w) / 640.0

    # Strand orientation from the structure tensor (strands run perpendicular to the gradient).
    # Only gradients inside the hair count, so the hair/background outline doesn't dominate.
    inner = cv2.erode((hair > 0.5).astype(np.uint8), np.ones((max(3, int(5 * scale)),) * 2, np.uint8))
    inner = cv2.GaussianBlur(inner.astype(np.float32), (0, 0), 2 * scale)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3) * inner
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3) * inner
    sig = 9 * scale
    jxx = cv2.GaussianBlur(gx * gx, (0, 0), sig)
    jyy = cv2.GaussianBlur(gy * gy, (0, 0), sig)
    jxy = cv2.GaussianBlur(gx * gy, (0, 0), sig)
    support = cv2.GaussianBlur(inner, (0, 0), sig)
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy)  # gradient direction
    tx, ty = -np.sin(theta), np.cos(theta)        # strand direction
    coherence = np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + 1e-9)
    # Where the texture is weak (or outside hair) assume hair simply falls downward
    trust = np.clip(coherence * 2.5, 0, 1) * np.clip(support * 2, 0, 1)
    flip = np.where(ty < 0, -1.0, 1.0)  # orientation is sign-free; point everything "down"
    tx, ty = tx * flip * trust, ty * flip * trust + (1 - trust)
    norm = np.sqrt(tx * tx + ty * ty) + 1e-6
    tx, ty = (tx / norm).astype(np.float32), (ty / norm).astype(np.float32)

    rng = np.random.default_rng(seed)
    base_x, base_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))

    def lic(cell: float, length: float) -> np.ndarray:
        nh, nw = max(2, int(h / cell)), max(2, int(w / cell))
        noise = cv2.resize(rng.random((nh, nw), dtype=np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        # Steps well under the noise cell size, otherwise the smear shows periodic banding
        steps = int(np.clip(np.ceil(length / (cell * 0.45)), 8, 64))
        step = length / steps
        field = np.dstack([tx, ty])
        acc = noise.copy()
        for sign in (1.0, -1.0):
            px, py = base_x.copy(), base_y.copy()
            dx, dy = tx * sign, ty * sign
            for _ in range(steps):
                px += dx * step
                py += dy * step
                nd = cv2.remap(field, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                flip = np.where(nd[..., 0] * dx + nd[..., 1] * dy < 0, -1.0, 1.0).astype(np.float32)
                dx, dy = nd[..., 0] * flip, nd[..., 1] * flip
                acc += cv2.remap(noise, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        acc /= 2 * steps + 1
        # Normalise to a predictable spread around 0.5 for the shader's thresholds
        wts = hair > 0.5
        ref = acc[wts] if wts.sum() > 500 else acc.ravel()
        acc = (acc - ref.mean()) / (ref.std() + 1e-6)
        return np.clip(acc * 0.16 + 0.5, 0, 1)

    fine = lic(cell=1.8 * scale, length=60 * scale)
    chunky = lic(cell=11 * scale, length=160 * scale)
    out = np.stack([fine, chunky, np.clip(tx * 0.5 + 0.5, 0, 1)], axis=-1)
    return (out * 255).astype(np.uint8)


def segment(image_bgr: np.ndarray) -> dict:
    h, w = image_bgr.shape[:2]
    hair, face = _run_model(image_bgr)

    # Second pass on a square crop around the head: the model only sees 256×256,
    # so zooming in gives noticeably tighter hair edges on half/full-body photos.
    box = _bbox(np.maximum(hair, face), 0.4)
    if box is not None:
        x0, y0, x1, y1 = box
        side = int(max(x1 - x0, y1 - y0) * 1.35)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        cx0, cy0 = max(0, cx - side // 2), max(0, cy - side // 2)
        cx1, cy1 = min(w, cx0 + side), min(h, cy0 + side)
        if (cx1 - cx0) * (cy1 - cy0) < 0.6 * w * h:
            ch, cf = _run_model(image_bgr[cy0:cy1, cx0:cx1])
            # Feather the paste so there is no seam at the crop border
            feather = np.ones_like(ch)
            f = max(4, int(0.04 * side))
            ramp = np.linspace(0, 1, f, dtype=np.float32)
            if cy0 > 0:
                feather[:f, :] *= ramp[:, None]
            if cy1 < h:
                feather[-f:, :] *= ramp[::-1, None]
            if cx0 > 0:
                feather[:, :f] *= ramp[None, :]
            if cx1 < w:
                feather[:, -f:] *= ramp[None, ::-1]
            hair[cy0:cy1, cx0:cx1] = hair[cy0:cy1, cx0:cx1] * (1 - feather) + ch * feather
            face[cy0:cy1, cx0:cx1] = face[cy0:cy1, cx0:cx1] * (1 - feather) + cf * feather

    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    r = max(4, int(max(h, w) / 180))
    hair_ref = np.clip(_guided_filter(gray, hair, r, 1e-3), 0, 1)
    hair_ref = np.clip((hair_ref - 0.12) / 0.76, 0, 1)
    face_soft = cv2.GaussianBlur(face, (0, 0), 2)

    hair_box = _bbox(hair_ref, 0.5)
    face_box = _bbox(face, 0.5)
    found = hair_box is not None

    lab = cv2.cvtColor(image_bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)
    wts = (hair_ref > 0.6).astype(np.float32)
    if wts.sum() > 100:
        L = lab[..., 0][wts > 0]
        hair_l, hair_l_std = float(L.mean()), float(L.std())
    else:
        hair_l, hair_l_std = 30.0, 10.0

    # Strand maps are smooth, so compute them at ≤640px (≈5× faster) and let the GPU upsample
    ss = min(1.0, 640 / max(h, w))
    small = (max(2, int(w * ss)), max(2, int(h * ss)))
    strands = _strand_textures(cv2.resize(gray, small, interpolation=cv2.INTER_AREA),
                               cv2.resize(hair_ref, small, interpolation=cv2.INTER_AREA),
                               seed=int(gray[::37, ::37].sum() * 1000) % (2**32))

    # Fall-backs so the shader always has sane geometry
    if face_box is None:
        if hair_box is not None:
            hx0, hy0, hx1, hy1 = hair_box
            fw = (hx1 - hx0) * 0.5
            face_box = (int((hx0 + hx1) / 2 - fw / 2), int(hy0 + (hy1 - hy0) * 0.2),
                        int((hx0 + hx1) / 2 + fw / 2), int(hy0 + (hy1 - hy0) * 0.6))
        else:
            face_box = (int(w * 0.35), int(h * 0.25), int(w * 0.65), int(h * 0.6))
    if hair_box is None:
        fx0, fy0, fx1, fy1 = face_box
        hair_box = (fx0, max(0, fy0 - (fy1 - fy0) // 3), fx1, fy1)

    mask_rgb = np.stack([hair_ref, face_soft, np.zeros_like(hair_ref)], axis=-1)
    return {
        "width": w,
        "height": h,
        "found": found,
        "hair": hair_ref,
        "mask_rgb": (np.clip(mask_rgb, 0, 1) * 255).astype(np.uint8),
        "strands": strands,
        "hair_box": [hair_box[0] / w, hair_box[1] / h, hair_box[2] / w, hair_box[3] / h],
        "face_box": [face_box[0] / w, face_box[1] / h, face_box[2] / w, face_box[3] / h],
        "hair_l": hair_l,
        "hair_l_std": hair_l_std,
    }


# ------------------------------------------------------------------- inpainting

def _get_lama():
    global _lama
    with _lama_lock:
        if _lama is None:
            import onnxruntime as ort
            _lama = ort.InferenceSession(str(LAMA_MODEL), providers=["CPUExecutionProvider"])
        return _lama


def make_plate(image_bgr: np.ndarray, hair: np.ndarray) -> np.ndarray:
    """Return the photo with all hair removed (background / shoulders filled in)."""
    h, w = image_bgr.shape[:2]
    # Generous hole: wispy ends left outside it get smeared back in as dark ghosts
    k = max(7, int(max(h, w) * 0.035)) | 1
    hole = cv2.dilate((hair > 0.03).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    box = _bbox(hole.astype(np.float32), 0.5)
    if box is None:
        return image_bgr.copy()

    # Square crop around the hole with some context, inpainted at LaMa's native 512²
    x0, y0, x1, y1 = box
    side = int(max(x1 - x0, y1 - y0) * 1.25)
    side = min(side, max(h, w))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    sx0 = int(np.clip(cx - side // 2, 0, max(0, w - side)))
    sy0 = int(np.clip(cy - side // 2, 0, max(0, h - side)))
    sx1, sy1 = min(w, sx0 + side), min(h, sy0 + side)
    crop = image_bgr[sy0:sy1, sx0:sx1]
    crop_hole = hole[sy0:sy1, sx0:sx1]
    ch, cw = crop.shape[:2]

    size = 512
    img_in = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), (size, size), interpolation=cv2.INTER_AREA)
    mask_in = (cv2.resize(crop_hole, (size, size), interpolation=cv2.INTER_NEAREST) > 0).astype(np.float32)
    img_t = img_in.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
    mask_t = mask_in[None, None]

    with _lama_lock:
        out = _get_lama().run(None, {"image": img_t, "mask": mask_t})[0][0]
    out = out.transpose(1, 2, 0)
    if out.max() <= 1.5:  # some exports return 0–1, others 0–255
        out = out * 255.0
    filled = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    filled = cv2.resize(filled, (cw, ch), interpolation=cv2.INTER_CUBIC)

    plate = image_bgr.copy()
    alpha = cv2.GaussianBlur(crop_hole.astype(np.float32), (0, 0), max(1.5, k / 6))[..., None]
    plate[sy0:sy1, sx0:sx1] = (crop * (1 - alpha) + filled * alpha).astype(np.uint8)
    return plate
