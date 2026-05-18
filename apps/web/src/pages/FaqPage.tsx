import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { faqSections } from '../data/faq';
import { markdownToHtml } from '../utils/markdownLight';

export function FaqPage() {
  return (
    <div className="min-h-screen">

      <Header />

      <div className="pt-8 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-4">Frequently Asked Questions</h1>
          <p className="text-text-secondary text-lg max-w-2xl mx-auto">
            Learn more about Unstream, streaming economics, and how to support artists directly.
          </p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto">
          {faqSections.length > 0 && (
            <div className="space-y-6">
              {faqSections.map((section, index) => (
                <details key={index} className="group bg-bg-secondary rounded-xl border border-border-primary">
                  <summary className="flex items-center justify-between cursor-pointer p-4 text-text-primary font-medium hover:bg-bg-hover transition-colors rounded-xl">
                    {section.title}
                    <span className="ml-2 text-text-muted group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <div
                    className="px-4 pb-4 text-text-secondary prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: markdownToHtml(section.content) }}
                  />
                </details>
              ))}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}