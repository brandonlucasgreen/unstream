import { useState, useEffect } from 'react';

export function usePWA() {
  const [isStandalone] = useState(() =>
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
     (navigator as any).standalone === true)
  );
  const [isIOS, setIsIOS] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [isChrome, setIsChrome] = useState(false);
  const [isFirefox, setIsFirefox] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [showIOSOverlay, setShowIOSOverlay] = useState(false);

  useEffect(() => {
    // Detect platform & browser
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua);
    const android = /Android/.test(ua);
    const mac = /Macintosh|Mac OS X/.test(ua) && !ios; // exclude iPad/iPhone
    const chrome = /Chrome\//.test(ua) && !/Edge|Edg|OPR|Firefox/.test(ua);
    const firefox = /Firefox\//.test(ua);
    setIsIOS(ios);
    setIsAndroid(android);
    setIsMobile(ios || android);
    setIsMac(mac);
    setIsChrome(chrome);
    setIsFirefox(firefox);

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
    isMac,
    isChrome,
    isFirefox,
    isPWAInstallable: !!installPrompt,
    showIOSOverlay,
    setShowIOSOverlay,
    handleInstallClick,
    handleIOSInstallClick,
  };
}