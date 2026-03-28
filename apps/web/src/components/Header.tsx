import { Link } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';
import { useTheme } from '../hooks/useTheme';

export function Header() {
  const { preference, cycleTheme } = useTheme();

  return (
    <header className="p-4 border-b border-border flex items-center justify-between">
      <Link to="/" className="text-xl font-bold text-accent-primary hover:opacity-80 transition-opacity">
        Unstream 🤘🏻
      </Link>
      <ThemeToggle preference={preference} onCycle={cycleTheme} />
    </header>
  );
}
