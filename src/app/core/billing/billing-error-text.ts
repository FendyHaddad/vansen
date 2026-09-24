// Plain-language text for billing error codes the web shows, and the App
// Store's subscription page. Codes not listed fall back to the server's
// message; a failure with no API error falls back to the caller's text.
import { ApiError } from '../api/api-service';

export const APP_STORE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';

const BILLING_ERROR_TEXT: Record<string, string> = {
  managed_in_app_store:
    'Your plan is billed by the App Store. Manage or cancel it in your Apple account settings.',
  subscribed_in_app_store:
    'You already have a plan through the App Store. Manage it in your Apple account settings.',
};

export function billingErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return BILLING_ERROR_TEXT[error.code] ?? error.message;
}
