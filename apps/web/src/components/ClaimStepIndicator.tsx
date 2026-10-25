import type { ClaimStep } from './ClaimPageTypes';

interface ClaimStepIndicatorProps {
  step: ClaimStep;
  authenticated: boolean;
}

export function ClaimStepIndicator({ step, authenticated }: ClaimStepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
      <span className={step === 'email' || step === 'check-email' ? 'text-link font-medium' : authenticated ? 'text-success' : ''}>
        1. Sign in
      </span>
      <span>{'>'}</span>
      <span className={step === 'website' ? 'text-link font-medium' : ['verify', 'review', 'done'].includes(step) ? 'text-success' : ''}>
        2. Website
      </span>
      <span>{'>'}</span>
      <span className={step === 'verify' ? 'text-link font-medium' : ['review', 'done'].includes(step) ? 'text-success' : ''}>
        3. Verify
      </span>
      <span>{'>'}</span>
      <span className={step === 'review' ? 'text-link font-medium' : step === 'done' ? 'text-success' : ''}>
        4. Review
      </span>
    </div>
  );
}
