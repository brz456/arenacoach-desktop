export type FreemiumQuotaFields = {
  entitlementMode: 'skillcapped' | 'freemium' | 'none';
  freeQuotaLimit: number | null;
  freeQuotaUsed: number | null;
  freeQuotaRemaining: number | null;
  freeQuotaExhausted: boolean;
};
