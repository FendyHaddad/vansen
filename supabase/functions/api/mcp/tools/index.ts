// The v1 tool set (spec §4), in the order clients list them.
import { getAccount } from "./account.ts";
import { listModels } from "./models.ts";
import { generateImage } from "./generate.ts";
import { getGeneration } from "./generation.ts";
import { upscaleImage } from "./upscale.ts";
import { varyImage } from "./vary.ts";
import { cancelGeneration } from "./cancel.ts";
import { listRecent } from "./recent.ts";

export const TOOLS = [
  getAccount,
  listModels,
  generateImage,
  getGeneration,
  upscaleImage,
  varyImage,
  cancelGeneration,
  listRecent,
];
