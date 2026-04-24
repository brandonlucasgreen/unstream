export type ClaimStep = 'email' | 'check-email' | 'website' | 'verify' | 'review' | 'done' | 'manual-review' | 'manual-review-submitted';

export interface ReviewLink {
  platform: string;
  url: string;
  checked: boolean;
}
