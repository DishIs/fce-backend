// api/src/v1/api-plans.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Plan definitions for the public developer API
//  Lives at:  api.freecustom.email/v1
// ─────────────────────────────────────────────────────────────────────────────

export type ApiPlanName = 'free' | 'developer' | 'startup' | 'growth' | 'enterprise';

export interface ApiPlanConfig {
  name: ApiPlanName;
  label: string;
  price: number; // USD / month (0 = free)
  rateLimit: {
    requestsPerSecond: number;
    requestsPerMonth: number;
  };
  features: {
    otpExtraction: boolean;
    attachments: boolean;
    maxAttachmentSizeMb: number; // 0 = blocked
    customDomains: boolean;
    websocket: boolean;
    maxWsConnections: number;    // 0 = blocked
  };
}

export const API_PLANS: Record<ApiPlanName, ApiPlanConfig> = {
  free: {
    name: 'free',
    label: 'Free',
    price: 0,
    rateLimit: { requestsPerSecond: 1, requestsPerMonth: 5_000 },
    features: {
      otpExtraction: false,
      attachments: false,
      maxAttachmentSizeMb: 0,
      customDomains: false,
      websocket: false,
      maxWsConnections: 0,
    },
  },
  developer: {
    name: 'developer',
    label: 'Developer',
    price: 7,
    rateLimit: { requestsPerSecond: 10, requestsPerMonth: 100_000 },
    features: {
      otpExtraction: false,
      attachments: false,
      maxAttachmentSizeMb: 0,
      customDomains: false,
      websocket: false,
      maxWsConnections: 0,
    },
  },
  startup: {
    name: 'startup',
    label: 'Startup',
    price: 19,
    rateLimit: { requestsPerSecond: 25, requestsPerMonth: 500_000 },
    features: {
      otpExtraction: false,
      attachments: true,
      maxAttachmentSizeMb: 5,
      customDomains: false,
      websocket: true,
      maxWsConnections: 5,
    },
  },
  growth: {
    name: 'growth',
    label: 'Growth',
    price: 49,
    rateLimit: { requestsPerSecond: 50, requestsPerMonth: 2_000_000 },
    features: {
      otpExtraction: true,
      attachments: true,
      maxAttachmentSizeMb: 25,
      customDomains: true,
      websocket: true,
      maxWsConnections: 20,
    },
  },
  enterprise: {
    name: 'enterprise',
    label: 'Enterprise',
    price: 149,
    rateLimit: { requestsPerSecond: 100, requestsPerMonth: 10_000_000 },
    features: {
      otpExtraction: true,
      attachments: true,
      maxAttachmentSizeMb: 50,
      customDomains: true,
      websocket: true,
      maxWsConnections: 100,
    },
  },
};

// ── Credits packages (never expire) ──────────────────────────────────────────
export interface CreditPackage {
  priceUsd: number;
  requests: number;
  label: string;
}

export const CREDIT_PACKAGES: CreditPackage[] = [
  { priceUsd: 10,  requests: 200_000,    label: '$10 → 200k requests'   },
  { priceUsd: 25,  requests: 600_000,    label: '$25 → 600k requests'   },
  { priceUsd: 50,  requests: 1_500_000,  label: '$50 → 1.5M requests'   },
  { priceUsd: 100, requests: 4_000_000,  label: '$100 → 4M requests'    },
];

// ── Feature-gate helpers ──────────────────────────────────────────────────────

/** Plans that support WebSocket access */
export const WS_PLANS: ApiPlanName[] = ['startup', 'growth', 'enterprise'];

/** Plans that expose OTP extraction */
export const OTP_PLANS: ApiPlanName[] = ['growth', 'enterprise'];

/** Plans that allow custom domain inboxes */
export const CUSTOM_DOMAIN_PLANS: ApiPlanName[] = ['growth', 'enterprise'];

/**
 * Map an API plan to the internal Redis/Mongo plan tier.
 * growth + enterprise get full "pro" inbox features (persistent storage, etc.).
 */
export function apiPlanToInternalPlan(apiPlan: ApiPlanName): 'pro' | 'free' | 'anonymous' {
  if (apiPlan === 'growth' || apiPlan === 'enterprise') return 'pro';
  if (apiPlan === 'free') return 'anonymous';
  return 'free'; // developer + startup
}