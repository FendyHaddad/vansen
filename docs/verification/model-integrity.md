# ML model integrity record (P7 Task 4)

Measured 2026-09-21. Covers T14 / R18.

Every model the editor can download is pinned to an immutable upstream commit,
and its size and SHA-256 were **measured by downloading the pinned file**, not
copied from a listing. `src/app/core/editing/engines/model-manifest.ts` holds
the same values; `model-manifest.spec.ts` refuses a `resolve/main` URL, a
missing hash, a non-commercial license and a banned source.

## How the revisions were resolved

```bash
curl -s "https://huggingface.co/api/models/<repo>" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])"
```

## How the hashes were measured

```bash
curl -sfL -o model.onnx "https://huggingface.co/<repo>/resolve/<revision>/<path>"
stat -f%z model.onnx
shasum -a 256 model.onnx
```

## The seven files

| id | repo @ revision | bytes | sha256 | license |
| --- | --- | --- | --- | --- |
| heal-migan | andraniksargsyan/migan @ `406830d0fa60666da0071c342ad2fbc8f30c5c64` | 28,079,181 | `6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b` | MIT |
| cutout-isnet | imgly/isnet-general-onnx @ `440dea96dd4a3b06bbbf5abec3e26569dd7ec49f` | 88,152,708 | `2eb4b5dda7ec41c617e59706e5aafa1f978c9a5f983d2518d9f0ae4d6eb04f20` | MIT |
| bokeh-depth-anything | onnx-community/depth-anything-v2-small @ `4472b7362082ad9968fee890ca0f1e5aca36b93d` | 27,258,801 | `fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d` | Apache-2.0 |
| upscale-swin2sr | Xenova/swin2SR-lightweight-x2-64 @ `92a21aca5713f20faf9a87590cdfbdce2e34112c` | 8,078,888 | `c2abbfe0cc8e685b5e11964970f8ebe3d24072e904fd5545a30ac31ec1e110db` | Apache-2.0 |
| select-slimsam-encoder | Xenova/slimsam-77-uniform @ `5850ab45f587c112167512ffef949107115e26a0` | 8,882,165 | `cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971` | Apache-2.0 |
| select-slimsam-decoder | Xenova/slimsam-77-uniform @ `5850ab45f587c112167512ffef949107115e26a0` | 4,903,810 | `cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2` | Apache-2.0 |
| deblur-nafnet | opencv/deblurring_nafnet @ `f1f255116cdb628a311d2b5749871189a4639d84` | 91,736,251 | `07263f416febecce10193dd648e950b22e397cf521eedab1a114ef77b2bc9587` | MIT |

Total: **257,091,804 bytes** (~257 MB). The cache budget is 320 MB, chosen so
every model fits at once — see below.

## Licenses: two repositories declare none of their own

Two of the seven are redistributions whose Hugging Face repositories carry no
license field at all:

- **Xenova/swin2SR-lightweight-x2-64** — an ONNX conversion of
  `caidas/swin2SR-lightweight-x2-64`, which **is** declared `apache-2.0`. The
  manifest records Apache-2.0 on the strength of the base model.
- **opencv/deblurring_nafnet** — no license metadata and no model card. NAFNet
  upstream is MIT, which is what this project already recorded when the tool
  shipped, and what the manifest records.

Neither is a blocker for shipping, but both are **weaker evidence than the
other five**, where the repository states its own license. If a license
question is ever raised about Upscale or AI Sharpen, these two rows are where
to look first. A self-hosted re-export with an explicit LICENSE file beside it
would close the gap.

## Budget

`MODEL_CACHE_BUDGET_BYTES = 320,000,000`, above the 257 MB manifest total.

The plan proposed 250 MB. That is **below** the manifest total, so a customer
who used every Pro tool would evict one model to make room for the next and
re-download it the next time — paying egress forever to keep a rounder number.
320 MB holds all seven with headroom and still refuses to let the editor grow
without limit. Eviction is least-recently-used, a model with a live ONNX
session is pinned and never evicted, and a cache that refuses to evict makes
the loader skip the cache write rather than fail the download.

## Not verified here

Task 6 must re-confirm these same revisions against real inference — a file
that hashes correctly can still be the wrong model for the tool that loads it.
