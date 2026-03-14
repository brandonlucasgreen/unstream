import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="border-t border-border py-6 px-4">
      <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
        <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" className="hover:text-text-primary transition-colors">Made with love in Massachusetts, USA</a>
        <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <Link to="/artist-login" className="hover:text-text-primary transition-colors">Artist login</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/artists" className="hover:text-text-primary transition-colors">Index</Link>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <a
            href="https://unstream.featurebase.app/roadmap"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-primary transition-colors"
          >
            Roadmap
          </a>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <a
            href="mailto:support@unstream.stream"
            className="hover:text-text-primary transition-colors"
          >
            Support
          </a>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <a
            href="https://liberapay.com/brandonlucasgreen/donate"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-primary transition-colors"
          >
            Donate
          </a>
          <span className="text-text-muted/40 text-xs">&#x2022;</span>
          <Link to="/privacy-policy" className="hover:text-text-primary transition-colors">Privacy</Link>
        </nav>
      </div>
    </footer>
  );
}
