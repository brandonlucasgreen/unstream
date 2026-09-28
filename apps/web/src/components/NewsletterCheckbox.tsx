import { LIGHTBULBS_ON_BLURB } from '../data/newsletter';

interface NewsletterCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The opt-in on the claim flow's email step. Unticked by default: claiming a profile is not
 * signing up for a newsletter.
 *
 * Deliberately not on /login. That page is both sign-up and sign-in, and it can't tell which
 * before the person is authenticated without revealing whether an address has an account
 * (account enumeration). New fans get the one-time NewsletterPrompt on /dashboard instead, which
 * they land on straight after their first sign-in.
 */
export function NewsletterCheckbox({ checked, onChange }: NewsletterCheckboxProps) {
  return (
    <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-accent-primary"
      />
      <span>{LIGHTBULBS_ON_BLURB}</span>
    </label>
  );
}
