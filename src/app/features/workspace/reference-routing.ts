import { GenerationOp } from '../../core/enums';
import type { GenerateRequest } from './left-panel/left-panel';

/** The op + reference fields a GenerateRequest turns into on the wire. */
export interface ReferenceRouting {
  op: GenerationOp;
  parentId: string | undefined;
  referenceUploadId: string | undefined;
}

/**
 * Only a LIBRARY reference is an edit — it has a parent generation to edit.
 * An uploaded reference has no parent, so it stays a generate and travels as
 * referenceUploadId; sending it as an edit made the gateway reject it with
 * invalid_parent before any model ran.
 *
 * Personas are generate-only; the server routes them to its own family.
 * Video never becomes an Edit op — its modes live in settings.mode instead.
 */
export function referenceRoutingFor(
  req: Pick<
    GenerateRequest,
    'settings' | 'referenceId' | 'referenceUploadId' | 'personaId'
  > & { videoParentId?: string | null },
): ReferenceRouting {
  const isImageEdit =
    req.settings.mode === undefined && !!req.referenceId && !req.personaId;
  return {
    op: isImageEdit ? GenerationOp.Edit : GenerationOp.Generate,
    parentId: req.videoParentId ?? req.referenceId ?? undefined,
    referenceUploadId: req.referenceUploadId ?? undefined,
  };
}
