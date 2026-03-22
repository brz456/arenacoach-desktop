export interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  tokenType?: string;
}

export interface UserInfo {
  // Contract: desktop user payloads return string IDs (backend normalizes with .toString())
  id: string;
  bnet_id: string;
  battletag: string;
  is_admin?: boolean;
  is_skill_capped_verified?: boolean;
  is_premium?: boolean;
  premium_sources?: Array<'skillcapped' | 'stripe'>;
  created_at?: string;
}

export type AuthErrorCode =
  | 'UNAUTHORIZED'
  | 'TRANSIENT'
  | 'RATE_LIMITED'
  | 'CONTRACT_VIOLATION'
  | 'NO_TOKEN';

export interface LoginResult {
  success: boolean;
  token?: AuthToken;
  user?: UserInfo;
  error?: string;
  errorCode?: AuthErrorCode;
  retryAfterMs?: number;
}
