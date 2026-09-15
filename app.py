"""
app.py — local web app: upload a photo, recolour and restyle hair live.

    .venv/bin/python app.py            # then open http://127.0.0.1:8000
"""

import base64
import hashlib
import threading
from collections import OrderedDict

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_from_directory, Response

import pipeline

MAX_SIDE = 1600

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

# Segmentation results are reused by /api/plate, keyed by a hash of the uploaded bytes
_cache: OrderedDict[str, dict] = OrderedDict()
_cache_lock = threading.Lock()


def _decode_upload():
    f = request.files.get("image")
    if f is None:
        return None, None, "No image uploaded"
    data = f.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None, None, "Could not read that file as an image"
    h, w = img.shape[:2]
    if max(h, w) > MAX_SIDE:
        s = MAX_SIDE / max(h, w)
        img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    return img, hashlib.sha1(data).hexdigest(), None


def _segment_cached(img, key):
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    result = pipeline.segment(img)
    with _cache_lock:
        _cache[key] = result
        while len(_cache) > 6:
            _cache.popitem(last=False)
    return result


def _png_data_url(arr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    return "data:image/png;base64," + base64.b64encode(buf).decode()


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.post("/api/segment")
def api_segment():
    img, key, err = _decode_upload()
    if err:
        return jsonify(error=err), 400
    r = _segment_cached(img, key)
    return jsonify(
        width=r["width"],
        height=r["height"],
        found=r["found"],
        mask=_png_data_url(r["mask_rgb"]),
        strands=_png_data_url(r["strands"]),
        hairBox=r["hair_box"],
        faceBox=r["face_box"],
        hairL=r["hair_l"],
        hairLStd=r["hair_l_std"],
    )


@app.post("/api/plate")
def api_plate():
    img, key, err = _decode_upload()
    if err:
        return jsonify(error=err), 400
    r = _segment_cached(img, key)
    plate = pipeline.make_plate(img, r["hair"])
    ok, buf = cv2.imencode(".jpg", plate, [cv2.IMWRITE_JPEG_QUALITY, 93])
    return Response(buf.tobytes(), mimetype="image/jpeg")


def _warm_up():
    # Loading LaMa takes ~20s on CPU; do it before the first photo arrives
    pipeline._get_segmenter()
    pipeline._get_lama()
    print(" * Models loaded — restyling is ready")


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()
    threading.Thread(target=_warm_up, daemon=True).start()
    print(f" * Hair studio: http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, threaded=True)
