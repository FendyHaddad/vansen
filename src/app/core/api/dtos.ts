import {
  GenerationOp,
  GenerationStatus,
  LedgerType,
  MediaKind,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../enums';
import { GenerationSettings } from '../catalog/model-families';

/** JSON contract with the api gateway — Java-swap boundary. */

export interface ProfileDto {
  id: string;
  email: string;
  displayName: string | null;
  prefs: Record<string, unknown>;
  createdAt: string;
}

export interface SubscriptionDto {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
}

/** Two-bucket credit balance: plan resets each cycle, pack rolls over. */
export interface CreditsDto {
  plan: number;
  pack: number;
}

export interface ProfileResponse {
  profile: ProfileDto;
  credits: CreditsDto;
  subscription: SubscriptionDto | null;
}

export interface LedgerEntryDto {
  id: string;
  type: LedgerType;
  amountCredits: number;
  bucket: 'plan' | 'pack';
  familyId: string | null;
  note: string | null;
  createdAt: string;
}

export interface LedgerResponse {
  entries: LedgerEntryDto[];
}

export interface GenerationDto {
  id: string;
  kind: MediaKind;
  familyId: string;
  familyName: string;
  op: GenerationOp;
  prompt: string;
  settings: GenerationSettings;
  priceCredits: number;
  status: GenerationStatus;
  mediaUrl: string;
  parentId: string | null;
  createdAt: string;
}

export interface GenerationsResponse {
  items: GenerationDto[];
}

export interface CreateGenerationRequest {
  familyId?: string;
  op: GenerationOp;
  prompt: string;
  settings: GenerationSettings;
  batch: number;
  parentId?: string;
  referenceUploadId?: string;
  maskPngBase64?: string;
}

export interface CreateGenerationResponse {
  items: GenerationDto[];
  credits: CreditsDto;
}

export interface JobsResponse {
  items: GenerationDto[];
}

export interface ModelsResponse {
  models: { id: string; enabled: boolean }[];
}

export interface UploadResponse {
  uploadId: string;
  url: string;
}

export interface SaveEditResponse {
  item: GenerationDto;
}

export interface SubscribeRequest {
  plan: 'studio' | 'pro';
}

export interface PackRequest {
  usd: number;
}

export interface CheckoutResponse {
  url: string;
}

export interface ReconcileResponse {
  credited: number;
  credits: CreditsDto;
}
