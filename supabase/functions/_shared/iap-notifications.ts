// App Store Server Notifications v2 type/subtype -> what the ledger writer does.
// Anything unmapped is deliberately ignored (200-and-ignore keeps us
// forward-compatible, same discipline as stripe-webhook).
export type IapAction =
  | 'cycle_grant'
  | 'pack_grant'
  | 'set_active'
  | 'set_canceled'
  | 'set_expired'
  | 'refund'
  | 'ignore';

export function actionFor(notificationType: string, subtype?: string): IapAction {
  if (notificationType === 'SUBSCRIBED') return 'cycle_grant';
  if (notificationType === 'DID_RENEW') return 'cycle_grant';
  if (notificationType === 'ONE_TIME_CHARGE') return 'pack_grant';
  if (notificationType === 'REFUND') return 'refund';
  if (notificationType === 'EXPIRED') return 'set_expired';
  if (notificationType === 'GRACE_PERIOD_EXPIRED') return 'set_expired';
  if (notificationType === 'DID_CHANGE_RENEWAL_STATUS') {
    if (subtype === 'AUTO_RENEW_DISABLED') return 'set_canceled';
    if (subtype === 'AUTO_RENEW_ENABLED') return 'set_active';
  }
  return 'ignore';
}
