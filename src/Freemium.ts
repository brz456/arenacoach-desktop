export type FreemiumQuotaFields = {
  entitlementMode: 'premium' | 'freemium' | 'free' | 'none';
  freeQuotaLimit: number | null;
  freeQuotaUsed: number | null;
  freeQuotaRemaining: number | null;
  freeQuotaExhausted: boolean;
};
