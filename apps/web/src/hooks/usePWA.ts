import { useState, useEffect } from 'react';

export function usePWA() {
  const [isStandalone, setIsStandalone] = useState(() =>
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
     (navigator as any).standalone === true)
  );
  const [isIOS, setIsIOS] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [showIOSOverlay, setShowIOSOverlay] = useState(false);

  useEffect(() => {
    // Detect platform
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua);
    const android = /Android/.test(ua);
    setIsIOS(ios);
    setIsAndroid(android);
    setIsMobile(ios || android);

    // Listen for beforeinstallprompt (Android)
    const handleInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    const promptEvent = installPrompt as any;
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    setInstallPrompt(null);
    return outcome;
  };

  const handleIOSInstallClick = () => {
    setShowIOSOverlay(true);
  };

  return {
    isStandalone,
    isIOS,
    isAndroid,
    isMobile,
    isPWAInstallable: !!installPrompt,
    showIOSOverlay,
    setShowIOSOverlay,
    handleInstallClick,
    handleIOSInstallClick,
  };
}