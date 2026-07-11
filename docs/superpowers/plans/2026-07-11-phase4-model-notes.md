# Phase 4 — ONNX model sourcing notes (Task 9)

Date: 2026-07-11. Every URL below was HEAD-checked on this date.

## AI Sharpen / Deblur — NAFNet ✅ READY

- **Repo:** `opencv/deblurring_nafnet` (HuggingFace, OpenCV model zoo)
- **URL:** `https://huggingface.co/opencv/deblurring_nafnet/resolve/main/deblurring_nafnet_2025may.onnx`
- **Verified:** HTTP 200, `Content-Length: 91736251` (~87.5 MiB). Quantized export
  (DequantizeLinear blocks), pytorch 2.0 origin.
- **License:** repo LICENSE = MIT (copyright 2022 megvii-model — the NAFNet
  authors). Code AND weights MIT. Commercial-safe. ✅
- **I/O spec** (from the zoo's `nafnet.py` reference implementation):
  - Input: NCHW float32 RGB, **dynamic H×W** (blob built at the image's own
    size), scale `1/255` (0..1), zero mean, `swapRB=True` (RGB order).
  - Output: `[1, 3, H, W]` float32 RGB 0..1 → `clip(out * 255, 0, 255)`.
  - Dynamic dims → tiles like `upscale-engine` work directly (SCALE=1).
- **Caveat:** this is the GoPro **deblur** variant. It is NOT a denoiser.

## Denoise — NAFNet-SIDD ❌ NO HOSTED ONNX

- Official + community HF repos (`nyanko7/`, `mikestealth/`, `tog/nafnet-models`)
  carry only `.pth` weights (MIT). No commercial-safe pre-exported ONNX found.
- `qualcomm/NAFNet-DeNoise` exists but `license: other` (Qualcomm AI Hub terms)
  — rejected.
- **Fallback:** export `NAFNet-SIDD-width32.pth` (MIT) to ONNX offline
  (torch.onnx, dynamic H/W, same 0..1 RGB contract as the deblur export) and
  host on a bucket we control. Offline job — outside the Angular app.

## Colorize — DDColor ❌ NO USABLE ONNX

- Official `piddnad/DDColor-models` (Apache-2.0): `.pth` only.
- `Diogo122333/ddcolor-512-fp16`: has ONNX but **456 MB** — far too big for a
  browser tool — and the repo carries no license metadata. Rejected.
- `qualcomm/DDColor`: `license: other`. Rejected.
- **Fallback:** export `ddcolor_paper_tiny` (Apache-2.0, the small variant) to
  ONNX offline at a fixed 512 input, fp16 — expected well under 100 MB — and
  host on a bucket we control.

## Decision needed (user)

1. Ship **AI Sharpen (deblur)** now from the verified MIT URL (87.5 MB
   first-use download, cached like the other engines)?
2. Approve the **offline export follow-up** for Denoise + Colorize (I prepare
   the export script; you run it and we host the .onnx on your storage)?
3. Or drop Denoise/Colorize from scope.
