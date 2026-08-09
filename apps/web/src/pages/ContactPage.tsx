import { useEffect, useRef } from 'react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { NewsletterSignup } from '../components/NewsletterSignup';

/**
 * Contact.
 *
 * Two things only: the Letterbird form and the newsletter signup. The homepage already embeds
 * Letterbird at the bottom of a long scroll, which is fine for someone who has already searched
 * but useless as a destination — there was nowhere to send a person who just wants to reach us.
 *
 * The newsletter sits *under* the contact form on purpose. Someone arriving here came to say
 * something, not to subscribe; putting the signup first would read as a toll booth.
 */
export function ContactPage() {
  const letterbirdRef = useRef<HTMLDivElement>(null);

  // Same mount guard as App.tsx: the embed script appends an iframe on load, so re-running it
  // under StrictMode's double-invoke would stack a second copy of the form.
  useEffect(() => {
    const el = letterbirdRef.current;
    if (el && !el.querySelector('script')) {
      const script = document.createElement('script');
      script.src = 'https://letterbird.co/embed/v1.js';
      script.setAttribute('data-letterbirduser', 'hi-d2078591');
      el.appendChild(script);
    }
  }, []);

  useEffect(() => {
    document.title = 'Contact — Unstream';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute(
        'content',
        'Get in touch with Unstream — ask a question, report a missing artist, suggest a feature, or subscribe to the newsletter.'
      );
    }
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <div className="pt-6 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary">
            Get in touch
          </h1>
        </div>
      </div>

      <main className="flex-1 px-4 pb-16">
        <div className="max-w-2xl mx-auto space-y-8">
          <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
            <p className="text-text-secondary mb-6">
              Can't find an artist you want to support? Spotted something wrong on an artist's page?
              Have a feature idea? Send it over — it all reaches a real person.
            </p>
            {/* .letterbird-contact is what index.css uses to let the embed's iframe auto-size;
                without it the iframe mounts at ~150px and the form is cramped. */}
            <div ref={letterbirdRef} className="letterbird-contact"></div>
          </div>

          <div className="bg-surface-secondary rounded-xl p-6 border border-border">
            <NewsletterSignup
              source="contact"
              heading="Or just keep in touch"
              blurb="New features, new platforms, and occasional writing on how to support music. No more than a couple of emails a month."
              feedUrl="/changelog.xml"
              feedLabel="changelog feed"
            />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
