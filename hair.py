"""
hair_recolor.py — segment hair in a photo and change its colour.
 
Setup:
    pip install mediapipe opencv-python numpy
 
    Download the segmentation model (once) into models/:
    https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite
 
Usage:
    python hair_recolor.py input.jpg output.jpg --color "#8B2FC9"
    python hair_recolor.py input.jpg output.jpg --color "#FF4500" --strength 0.8
    python hair_recolor.py input.jpg output.jpg --color "#2E86DE" --save-mask mask.png
"""
 
import argparse
import sys
 
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
 
HAIR_CLASS = 1  # selfie_multiclass labels: 0 bg, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 other
 
 
def hex_to_bgr(hex_color: str) -> np.ndarray:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        sys.exit(f"Bad colour '{hex_color}' — use #RRGGBB")
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return np.array([b, g, r], dtype=np.float32)
 
 
def get_hair_mask(image_bgr: np.ndarray, model_path: str) -> np.ndarray:
    """Return a float mask in [0,1], same H×W as the image, 1 = hair."""
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
 
    options = vision.ImageSegmenterOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        output_category_mask=False,
        output_confidence_masks=True,
    )
    with vision.ImageSegmenter.create_from_options(options) as segmenter:
        result = segmenter.segment(mp_image)
 
    mask = result.confidence_masks[HAIR_CLASS].numpy_view().astype(np.float32)
    if mask.shape[:2] != image_bgr.shape[:2]:
        mask = cv2.resize(mask, (image_bgr.shape[1], image_bgr.shape[0]))
 
    # Clean up edges: soften and slightly threshold noise
    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=3)
    mask = np.clip((mask - 0.15) / 0.7, 0, 1)
    return mask
 
 
def recolor_hair(image_bgr: np.ndarray, mask: np.ndarray, target_bgr: np.ndarray, strength: float) -> np.ndarray:
    """
    Change the hue/saturation of the hair to the target colour while keeping the
    original lightness (so strands, highlights and shadows are preserved).
    """
    img = image_bgr.astype(np.float32)
 
    # Work in LAB: keep L from the original, take a/b from the target colour
    lab = cv2.cvtColor(img / 255.0, cv2.COLOR_BGR2LAB)
    target_lab = cv2.cvtColor(target_bgr.reshape(1, 1, 3) / 255.0, cv2.COLOR_BGR2LAB)[0, 0]
 
    recolored = lab.copy()
    recolored[..., 1] = target_lab[1]
    recolored[..., 2] = target_lab[2]
 
    # Nudge lightness toward the target so very dark hair can go light and vice versa
    l_shift = (target_lab[0] - lab[..., 0].mean()) * 0.5
    recolored[..., 0] = np.clip(lab[..., 0] + l_shift, 0, 100)
 
    recolored_bgr = cv2.cvtColor(recolored, cv2.COLOR_LAB2BGR) * 255.0
 
    alpha = (mask * strength)[..., None]
    out = img * (1 - alpha) + recolored_bgr * alpha
    return np.clip(out, 0, 255).astype(np.uint8)
 
 
def main():
    p = argparse.ArgumentParser(description="Segment hair and change its colour.")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--color", default="#8B2FC9", help="Target colour as #RRGGBB")
    p.add_argument("--strength", type=float, default=0.9, help="0–1, how strongly to apply the colour")
    p.add_argument("--model", default="models/selfie_multiclass_256x256.tflite", help="Path to the MediaPipe model")
    p.add_argument("--save-mask", help="Optional path to write the hair mask as a PNG")
    args = p.parse_args()
 
    image = cv2.imread(args.input)
    if image is None:
        sys.exit(f"Could not read image: {args.input}")
 
    mask = get_hair_mask(image, args.model)
    if mask.max() < 0.2:
        print("Warning: little or no hair detected — check the photo or model path.")
 
    if args.save_mask:
        cv2.imwrite(args.save_mask, (mask * 255).astype(np.uint8))
 
    result = recolor_hair(image, mask, hex_to_bgr(args.color), np.clip(args.strength, 0, 1))
    cv2.imwrite(args.output, result)
    print(f"Saved -> {args.output}")
 
 
if __name__ == "__main__":
    main()