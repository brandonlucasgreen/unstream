import { LIGHTBULBS_ON_BLURB } from '../data/newsletter';

interface NewsletterCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The opt-in shown where someone gives us their email to sign in or claim a profile.
 * Unticked by default: signing up for Unstream is not signing up for a newsletter.
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
