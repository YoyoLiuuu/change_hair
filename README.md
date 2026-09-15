# Hair Studio

A local website: upload a photo, then try new hair colours, salon techniques and cuts live in the browser.

## Run it

```bash
cd ~/GitHub/change_hair
.venv/bin/python app.py          # then open http://127.0.0.1:8000
```

The first start takes about 20 seconds while the inpainting model loads. The page works for colour
straight away; **Cut & style** unlocks a few seconds after each upload.

### Fresh setup (if `.venv` or `models/` is missing)

```bash
uv venv .venv -p 3.12                       # or: python3.12 -m venv .venv
uv pip install -p .venv/bin/python -r requirements.txt
mkdir -p models
curl -L -o models/selfie_multiclass_256x256.tflite \
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite
curl -L -o models/lama_fp32.onnx \
  https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx
```

`mediapipe` is pinned to 0.10.21 because newer builds need the system library `libGLESv2`.

## What's in the app

| Tab | What you get |
| --- | --- |
| **Looks** | 35 ready-made salon looks: Mocha Brown, Caramel / Honey / Ash Blonde Balayage, Babylights, Money Piece, Bronde, Platinum, Copper, Cherry Cola, Rose Gold Ombré, Split Dye, and more |
| **Colour** | Technique (All-over, Balayage, Ombré, Babylights, Highlights, Split dye), main + highlight colour wells, a live colour picker with hex input, 28 named hair shades, and sliders for intensity, lightness, highlight amount, where the colour starts, root shadow, face-framing and shine |
| **Cut & style** | Pixie, Bob, Lob, Wavy bob, Longer, Beach waves, Glam waves, Perm curls, Blowout, Sleek straight, Curtain bangs, plus sliders for length, volume, waves, wave pattern, curls, sleekness and bangs |

You can also compare before and after with a draggable divider, view the detected hair mask, and download the result.

## How it works

```
browser ──upload──▶ /api/segment  (pipeline.segment)
                     • MediaPipe selfie_multiclass → hair + face masks (2nd zoomed pass on the head)
                     • guided filter snaps the 256px mask to real strand edges
                     • strand-direction field + line-integral-convolution noise, so
                       highlights and babylights follow the hair
        ──upload──▶ /api/plate    (pipeline.make_plate)
                     • LaMa inpainting paints the hair out, so hair can be cut or moved
browser  WebGL shader (static/js/renderer.js) does every colour and style change per frame
```

* **Colour** is applied in CIE Lab. The photo's own light and shade is kept as a ratio, so
  strands, shadows and shine survive when you go darker or lighter.
* **Styles** warp the hair layer (waves, curls, volume, bangs), cut it at a new length, and
  reveal the inpainted background where hair was removed.

## Limitations

* Cuts and textures are fast image-warping approximations, not generated hair. They look best on
  front-facing photos with hair clearly visible. Tilted heads, profiles, or hair covering most
  of the frame can leave smudges where the background is filled in.
* Going from very dark to very light hair is the hardest case. Use **Lightness** in the Colour tab
  to fine-tune any shade to your photo.
* `hair.py` is the original command-line recolouring script and still works:
  `.venv/bin/python hair.py in.jpg out.jpg --color "#6e4b35"`.
