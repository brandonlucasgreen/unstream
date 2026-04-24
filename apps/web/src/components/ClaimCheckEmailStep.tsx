interface ClaimCheckEmailStepProps {
  email: string;
  loading: boolean;
  resendCooldown: number;
  onResend: () => void;
  onUseDifferentEmail: () => void;
}

export function ClaimCheckEmailStep({
  email,
  loading,
  resendCooldown,
  onResend,
  onUseDifferentEmail,
}: ClaimCheckEmailStepProps) {
  return (
    <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
      <div className="text-3xl">📧</div>
      <p className="font-medium">Check your email</p>
      <p className="text-sm text-text-muted">
        We sent a sign-in link to <strong className="text-text-primary">{email}</strong>.
        Click the link to continue claiming your profile.
      </p>
      <p className="text-xs text-text-muted">
        Don't see it? Check your spam or junk folder.
        {email.includes('privaterelay.appleid.com') && (
          <> If you used Apple's Hide My Email, delivery may take a few extra minutes.</>
        )}
      </p>
      <div className="space-y-2">
        <div>
          <button
            onClick={onResend}
            disabled={resendCooldown > 0 || loading}
            className="text-sm text-accent-primary hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend email'}
          </button>
        </div>
        <div>
          <button
            onClick={onUseDifferentEmail}
            className="text-xs text-text-muted hover:text-text-primary underline"
          >
            Use a different email
          </button>
        </div>
      </div>
    </div>
  );
}
