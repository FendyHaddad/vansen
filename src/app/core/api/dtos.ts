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
  /** Plan booked to take effect at pendingAt; null when nothing is scheduled. */
  pendingPlan: 'studio' | 'pro' | null;
  pendingAt: string | null;
}

/** Studio <-> Pro. 'now' restarts the cycle; 'period_end' books it for renewal. */
export interface ChangePlanRequest {
  plan: 'studio' | 'pro';
  when: 'now' | 'period_end';
}

export interface ChangePlanResponse {
  plan: 'studio' | 'pro';
  /** ISO date the change lands, or null when it already has. */
  effectiveAt: string | null;
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

/** Live-from-Stripe details for the Subscription tab (mirror covers the rest). */
export interface BillingOverviewDto {
  cancelAtPeriodEnd: boolean;
  upcoming: { amountUsd: number; date: string | null } | null;
  paymentMethod: { brand: string; last4: string } | null;
}

export interface CancelSubscriptionRequest {
  /** Survey answer from the cancel flow — stored on the Stripe subscription. */
  reason: string;
}

export interface CancelStateResponse {
  cancelAtPeriodEnd: boolean;
}
