import type { ClaimStep } from './ClaimPageTypes';

interface ClaimStepIndicatorProps {
  step: ClaimStep;
  authenticated: boolean;
}

export function ClaimStepIndicator({ step, authenticated }: ClaimStepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
      <span className={step === 'email' || step === 'check-email' ? 'text-accent-primary font-medium' : authenticated ? 'text-green-400' : ''}>
        1. Sign in
      </span>
      <span>{'>'}</span>
      <span className={step === 'website' ? 'text-accent-primary font-medium' : ['verify', 'review', 'done'].includes(step) ? 'text-green-400' : ''}>
        2. Website
      </span>
      <span>{'>'}</span>
      <span className={step === 'verify' ? 'text-accent-primary font-medium' : ['review', 'done'].includes(step) ? 'text-green-400' : ''}>
        3. Verify
      </span>
      <span>{'>'}</span>
      <span className={step === 'review' ? 'text-accent-primary font-medium' : step === 'done' ? 'text-green-400' : ''}>
        4. Review
      </span>
    </div>
  );
}
