import { useMemo } from 'react';
import {
  AUTOPOST_KINDS,
  DEFAULT_TEMPLATES,
  releaseTemplateVars,
  renderTemplate,
  supportTemplateVars,
  templateProblems,
  type AutopostKind,
  type TemplateRelease,
} from '../../../../api/shared/autopost-templates';

// "What to say" on the Promote page: each kind of post, switched on or off, with its variants in
// editable boxes and a live preview against the artist's newest release. The template language is
// the shared one (api/shared/autopost-templates.ts), so the preview is exactly what the sweep posts.

export const KIND_COPY: Record<AutopostKind, { label: string; when: string }> = {
  bandcamp_friday: { label: 'Bandcamp Friday', when: 'On Bandcamp Fridays, about your newest release there.' },
  release_day: { label: 'Release day', when: 'On the day a new release comes out, if Unstream finds it before then.' },
  preorder: { label: 'Pre-order', when: 'Once, when a new release is announced at least three days ahead.' },
  out_now: { label: 'Out now', when: 'For a new release Unstream only finds after its release day.' },
  still_new: { label: 'Still new', when: 'A release in its first six weeks, at most every other post.' },
  catalogue: { label: 'From the archives', when: 'Everything else: your releases in turn, so nothing repeats too soon.' },
  support: { label: 'Ways to support you', when: 'Only at three or more posts a week, and at most one post in four.' },
};

const MAX_VARIANTS = 5;

/** The variants a kind shows: the artist's own, or Unstream's until they edit them. */
export function variantsShown(kind: AutopostKind, templates: Partial<Record<AutopostKind, string[]>>): string[] {
  return templates[kind] ?? DEFAULT_TEMPLATES[kind];
}

export function PromoteTemplatesEditor({ templates, kindsOff, previewRelease, artist, takesTips, onChange, problems }: {
  /** Only kinds the artist has edited; the rest show Unstream's wording. */
  templates: Partial<Record<AutopostKind, string[]>>;
  kindsOff: AutopostKind[];
  previewRelease: TemplateRelease | null;
  artist: { name: string; slug: string };
  takesTips: boolean;
  onChange: (next: { templates: Partial<Record<AutopostKind, string[]>>; kindsOff: AutopostKind[] }) => void;
  /** What the server refused, per kind. */
  problems?: Record<string, string[]>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const releaseVars = useMemo(
    () => (previewRelease ? releaseTemplateVars(previewRelease, artist, { postDate: today, instagram: false }) : null),
    [previewRelease, artist, today],
  );
  const supportVars = useMemo(() => supportTemplateVars(artist, { takesTips, instagram: false }), [artist, takesTips]);

  const setVariants = (kind: AutopostKind, variants: string[]) => {
    const next = { ...templates };
    // Back to exactly Unstream's wording means "use the defaults", which keeps getting improvements.
    if (variants.join('\n') === DEFAULT_TEMPLATES[kind].join('\n')) delete next[kind];
    else next[kind] = variants;
    onChange({ templates: next, kindsOff });
  };
  const setOn = (kind: AutopostKind, on: boolean) =>
    onChange({ templates, kindsOff: on ? kindsOff.filter(k => k !== kind) : [...kindsOff, kind] });

  return (
    <div className="space-y-5">
      <p className="text-xs text-text-muted">
        Facts in curly brackets are filled in for each post: <code>{'{title}'}</code>, <code>{'{type}'}</code>, <code>{'{date}'}</code>,{' '}
        <code>{'{year}'}</code>, <code>{'{age}'}</code>, <code>{'{where}'}</code>, <code>{'{price}'}</code>, <code>{'{link}'}</code>,{' '}
        <code>{'{name}'}</code> and <code>{'{note}'}</code>. Anything in square brackets is left out when a fact inside it is missing,
        so <code>{'{title}[, from {year}]'}</code> works for undated releases too. When a kind of post has more than one
        template, autopost takes turns with them, so two posts in a row don’t read the same.
      </p>
      {AUTOPOST_KINDS.map(kind => {
        const on = !kindsOff.includes(kind);
        const variants = variantsShown(kind, templates);
        const vars = kind === 'support' ? supportVars : releaseVars;
        const edited = Boolean(templates[kind]);
        return (
          <fieldset key={kind} className="space-y-2 border-t border-border pt-4">
            <legend className="sr-only">{KIND_COPY[kind].label}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={on} onChange={e => setOn(kind, e.target.checked)} className="mt-1" />
              <span>
                <span className="font-medium text-text-primary">{KIND_COPY[kind].label}</span>
                <span className="block text-xs text-text-muted">{KIND_COPY[kind].when}</span>
              </span>
            </label>
            {on && (
              // Folded away until wanted: most artists keep the defaults, and seven kinds of post with
              // every variant open is a wall. Opens by itself when something needs fixing.
              <details className="pl-6" open={Boolean(problems?.[kind]) || variants.some(v => templateProblems(v).length > 0) || undefined}>
                <summary className="cursor-pointer text-xs text-link hover:underline">Edit templates</summary>
                <div className="space-y-2 pt-2">
                  {variants.map((variant, i) => {
                    const found = templateProblems(variant);
                    const preview = vars ? renderTemplate(variant, vars) : null;
                    return (
                      <div key={i} className="space-y-1">
                        <div className="flex gap-2">
                          <textarea
                            value={variant}
                            aria-label={`${KIND_COPY[kind].label}, template ${i + 1}`}
                            rows={2}
                            onChange={e => setVariants(kind, variants.map((v, j) => (j === i ? e.target.value : v)))}
                            className="flex-1 px-2 py-1 text-sm bg-bg-primary border border-border rounded-lg"
                          />
                          {variants.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setVariants(kind, variants.filter((_, j) => j !== i))}
                              className="self-start text-xs text-text-muted hover:text-text-primary px-1"
                              aria-label={`Remove ${KIND_COPY[kind].label} template ${i + 1}`}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        {found.length > 0 ? (
                          <p className="text-xs text-error">{found.join(' · ')}</p>
                        ) : vars ? (
                          <p className="text-xs text-text-secondary whitespace-pre-line">
                            {preview ?? 'Can’t be filled for your newest release, so the next template would be used.'}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                  {problems?.[kind] && <p className="text-xs text-error">{problems[kind].join(' · ')}</p>}
                  <div className="flex gap-3 text-xs">
                    {variants.length < MAX_VARIANTS && (
                      <button type="button" onClick={() => setVariants(kind, [...variants, ''])} className="text-link hover:underline">
                        Add a template
                      </button>
                    )}
                    {edited && (
                      <button type="button" onClick={() => setVariants(kind, DEFAULT_TEMPLATES[kind])} className="text-link hover:underline">
                        Back to Unstream’s wording
                      </button>
                    )}
                  </div>
                </div>
              </details>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
