import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function Footer() {
  const { t } = useTranslation();

  return (
    <footer className="border-t border-border py-6 px-4">
      <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
        <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" className="hover:text-text-primary transition-colors">{t('footer.madeWithLove')}</a>
        <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <Link to="/artists" className="hover:text-text-primary transition-colors">{t('footer.indieArtistIndex')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/known-artists" className="hover:text-text-primary transition-colors">{t('footer.artistsYouKnow')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/platforms" className="hover:text-text-primary transition-colors">{t('footer.platforms')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/changelog" className="hover:text-text-primary transition-colors">{t('footer.changelog')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/press" className="hover:text-text-primary transition-colors">{t('footer.pressKit')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/support" className="hover:text-text-primary transition-colors">{t('footer.support')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/faq" className="hover:text-text-primary transition-colors">{t('footer.faq')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/contact" className="hover:text-text-primary transition-colors">{t('footer.contact')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/terms" className="hover:text-text-primary transition-colors">{t('footer.terms')}</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/privacy-policy" className="hover:text-text-primary transition-colors">{t('footer.privacy')}</Link>
        </nav>
      </div>
    </footer>
  );
}
