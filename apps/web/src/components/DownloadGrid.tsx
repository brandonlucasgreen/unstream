import { analytics } from '../services/analytics';
import { usePWA } from '../hooks/usePWA';

export function DownloadGrid() {
  const {
    isStandalone,
    isIOS,
    isAndroid,
    isMobile,
    isPWAInstallable,
    showIOSOverlay,
    setShowIOSOverlay,
    handleInstallClick,
    handleIOSInstallClick,
  } = usePWA();

  if (isStandalone) return null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto items-stretch">
        {/* Top-left: macOS / Install button */}
        {isIOS && isMobile ? (
          <button
            className="flex h-full items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#9CA3AF] text-white hover:bg-[#8B92A0] transition-colors font-medium shadow-lg shadow-[#9CA3AF]/20"
            onClick={handleIOSInstallClick}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add to Home Screen
          </button>
        ) : isAndroid && isMobile && isPWAInstallable ? (
          <button
            className="flex h-full items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#9CA3AF] text-white hover:bg-[#8B92A0] transition-colors font-medium shadow-lg shadow-[#9CA3AF]/20"
            onClick={handleInstallClick}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Install App
          </button>
        ) : (
          <a
            href="https://github.com/brandonlucasgreen/unstream/releases/latest"
            className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#9CA3AF] text-white hover:bg-[#8B92A0] transition-colors font-medium shadow-lg shadow-[#9CA3AF]/20"
            onClick={() => analytics.trackDownload()}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            Download for macOS
          </a>
        )}

        {/* Top-right: iOS Shortcut */}
        <a
          href="https://www.icloud.com/shortcuts/73296296361e4f609087746e7f046d47"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#007AFF] text-white hover:bg-[#0066d6] transition-colors font-medium shadow-lg shadow-[#007AFF]/20"
          onClick={() => analytics.trackDownloadIosShortcut()}
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
          </svg>
          Install iOS Shortcut
        </a>

        {/* Bottom-left: Chrome */}
        <a
          href="https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#34A853] text-white hover:bg-[#2d9249] transition-colors font-medium shadow-lg shadow-[#34A853]/20"
          onClick={() => analytics.trackDownloadChrome()}
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728z"/>
          </svg>
          Install for Chrome
        </a>

        {/* Bottom-right: Firefox */}
        <a
          href="https://addons.mozilla.org/en-US/firefox/addon/unstream/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#FF6611] text-white hover:bg-[#e55b0e] transition-colors font-medium shadow-lg shadow-[#FF6611]/20"
          onClick={() => analytics.trackDownloadFirefox()}
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z"/>
          </svg>
          Install for Firefox
        </a>
      </div>

      {/* iOS "Add to Home Screen" overlay */}
      {showIOSOverlay && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-end justify-center pb-8 px-4"
          onClick={() => setShowIOSOverlay(false)}
        >
          <div
            className="bg-bg-secondary rounded-2xl p-6 max-w-sm w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-text-primary mb-3">Add Unstream to your Home Screen</h3>
            <ol className="text-text-secondary space-y-2 mb-4">
              <li className="flex items-start gap-2">
                <span className="text-accent-secondary font-bold">1.</span>
                <span>Tap the <strong>Share button</strong> at the bottom of Safari</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent-secondary font-bold">2.</span>
                <span>Scroll down and tap <strong>&ldquo;Add to Home Screen&rdquo;</strong></span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent-secondary font-bold">3.</span>
                <span>Tap <strong>&ldquo;Add&rdquo;</strong> in the top right</span>
              </li>
            </ol>
            <button
              className="w-full py-3 rounded-xl bg-accent-secondary text-white font-medium hover:opacity-90 transition-opacity"
              onClick={() => setShowIOSOverlay(false)}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}