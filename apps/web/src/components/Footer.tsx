import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="border-t border-border py-6 px-4">
      <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
        <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" className="hover:text-text-primary transition-colors">Made with love in Massachusetts, USA</a>
        <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <Link to="/artists" className="hover:text-text-primary transition-colors">Indie Artist Index</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/known-artists" className="hover:text-text-primary transition-colors">Artists You Know</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/guides" className="hover:text-text-primary transition-colors">Guides</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/changelog" className="hover:text-text-primary transition-colors">Changelog</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <a
            href="https://github.com/brandonlucasgreen/unstream"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-primary transition-colors"
          >
            Codebase
          </a>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/support" className="hover:text-text-primary transition-colors">Donate</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/faq" className="hover:text-text-primary transition-colors">FAQ</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <a
            href="https://letterbird.co/hi-d2078591"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-primary transition-colors"
          >
            Contact
          </a>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/privacy-policy" className="hover:text-text-primary transition-colors">Privacy policy</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/terms" className="hover:text-text-primary transition-colors">Terms of use</Link>
        </nav>
      </div>
    </footer>
  );
}
