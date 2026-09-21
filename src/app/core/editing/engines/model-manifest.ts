/**
 * Every ML model the editor can download, pinned.
 *
 * These files come from huggingface.co and run in the customer's browser.
 * Until this manifest existed nothing checked what came back: a swapped or
 * corrupted upstream file was executed as a model, and roughly 250 MB could
 * accumulate in Cache Storage with no ceiling.
 *
 * Every URL names an immutable 40-character commit, never `resolve/main`: a
 * hash measured against a moving branch is a hash of something that can
 * change under us. Sizes and hashes are measured, never guessed — the
 * measurements behind this file are recorded in
 * `docs/verification/model-integrity.md`.
 */
export interface ModelEntry {
  url: string;
  bytes: number;
  sha256: string;
  /** Must be commercially usable. MIT and Apache-2.0 only. */
  license: 'MIT' | 'Apache-2.0';
  /** Ask before spending the customer's bandwidth on a large file. */
  warnBeforeDownload: boolean;
  /** Shown in the download prompt — plain words, not an id. */
  label: string;
}

export type ModelId =
  | 'heal-migan'
  | 'cutout-isnet'
  | 'bokeh-depth-anything'
  | 'upscale-swin2sr'
  | 'select-slimsam-encoder'
  | 'select-slimsam-decoder'
  | 'deblur-nafnet';

/** Pinned upstream commits, resolved from each repository's own API. */
const MIGAN_REVISION = '406830d0fa60666da0071c342ad2fbc8f30c5c64';
const DEPTH_ANYTHING_REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
const SWIN2SR_REVISION = '92a21aca5713f20faf9a87590cdfbdce2e34112c';
const SLIMSAM_REVISION = '5850ab45f587c112167512ffef949107115e26a0';
const NAFNET_REVISION = 'f1f255116cdb628a311d2b5749871189a4639d84';
const ISNET_REVISION = '440dea96dd4a3b06bbbf5abec3e26569dd7ec49f';

export const MODEL_MANIFEST: Record<ModelId, ModelEntry> = {
  'heal-migan': {
    url:
      `https://huggingface.co/andraniksargsyan/migan/resolve/${MIGAN_REVISION}/migan_pipeline_v2.onnx`,
    bytes: 28_079_181,
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
    license: 'MIT',
    warnBeforeDownload: true,
    label: 'Healing',
  },
  'cutout-isnet': {
    url:
      `https://huggingface.co/imgly/isnet-general-onnx/resolve/${ISNET_REVISION}/onnx/model_fp16.onnx`,
    bytes: 88_152_708,
    sha256: '2eb4b5dda7ec41c617e59706e5aafa1f978c9a5f983d2518d9f0ae4d6eb04f20',
    license: 'MIT',
    warnBeforeDownload: true,
    label: 'Cut Out',
  },
  'bokeh-depth-anything': {
    url:
      `https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/${DEPTH_ANYTHING_REVISION}/onnx/model_quantized.onnx`,
    bytes: 27_258_801,
    sha256: 'fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d',
    license: 'Apache-2.0',
    warnBeforeDownload: true,
    label: 'Bokeh',
  },
  'upscale-swin2sr': {
    url:
      `https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/${SWIN2SR_REVISION}/onnx/model.onnx`,
    bytes: 8_078_888,
    sha256: 'c2abbfe0cc8e685b5e11964970f8ebe3d24072e904fd5545a30ac31ec1e110db',
    license: 'Apache-2.0',
    warnBeforeDownload: false,
    label: 'Upscale',
  },
  'select-slimsam-encoder': {
    url:
      `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/${SLIMSAM_REVISION}/onnx/vision_encoder_quantized.onnx`,
    bytes: 8_882_165,
    sha256: 'cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971',
    license: 'Apache-2.0',
    warnBeforeDownload: false,
    label: 'Smart Select',
  },
  'select-slimsam-decoder': {
    url:
      `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/${SLIMSAM_REVISION}/onnx/prompt_encoder_mask_decoder_quantized.onnx`,
    bytes: 4_903_810,
    sha256: 'cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2',
    license: 'Apache-2.0',
    warnBeforeDownload: false,
    label: 'Smart Select',
  },
  'deblur-nafnet': {
    url:
      `https://huggingface.co/opencv/deblurring_nafnet/resolve/${NAFNET_REVISION}/deblurring_nafnet_2025may.onnx`,
    bytes: 91_736_251,
    sha256: '07263f416febecce10193dd648e950b22e397cf521eedab1a114ef77b2bc9587',
    license: 'MIT',
    warnBeforeDownload: true,
    label: 'AI Sharpen',
  },
};

export const TOTAL_MANIFEST_BYTES = Object.values(MODEL_MANIFEST).reduce(
  (sum, entry) => sum + entry.bytes,
  0,
);

export function modelFor(id: ModelId): ModelEntry {
  const entry = MODEL_MANIFEST[id];
  if (!entry) throw new Error(`unknown model: ${id}`);
  return entry;
}
