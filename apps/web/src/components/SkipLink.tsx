/**
 * "Skip to main content": the first focusable element on every page, visible only once focused,
 * so a keyboard user can pass the header and its navigation in one keystroke.
 *
 * It moves focus by hand rather than following `href="#main"`: pages don't share a main id, and a
 * hash in the URL would change how ScrollToTop treats the next navigation. Targets the page's
 * <main>, or its first heading on the few pages without one.
 */
export function SkipLink() {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const target = document.querySelector<HTMLElement>('main') ?? document.querySelector<HTMLElement>('h1')
    if (!target) return
    event.preventDefault()
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus()
  }

  return (
    <a
      href="#main"
      onClick={handleClick}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:border focus:border-border focus:bg-bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-text-primary focus:shadow-lg"
    >
      Skip to main content
    </a>
  )
}
