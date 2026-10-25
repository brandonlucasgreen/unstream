import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { titleForPath } from '../data/routeTitles'

// Where a screen-reader or keyboard user is after a navigation. A SPA route change only swaps
// the DOM: focus stays on the link that was clicked (often now gone) and nothing is announced, so
// the new page is silent until the reader explores. On each forward navigation this:
//
// - sets the route's starting title (see data/routeTitles.ts);
// - moves focus to the new page's <h1>, which reads its heading and puts the next Tab inside
//   the page rather than back at the top of the header;
// - when the page has no <h1> to land on, announces the title in a polite live region instead.
//
// Left alone, matching ScrollToTop: back/forward (the browser restores position and focus is
// the user's), same-path changes (the search page rewrites ?q= as you type), and hash links
// (the anchor decides). Focus is never taken from a text field — the header search navigates to
// /?q= while its input still has focus — or from an open dialog.

/** How long to wait for a lazily loaded page to render its heading. */
const HEADING_WAIT_MS = 3000

function isEditable(element: Element | null): boolean {
  if (!element) return false
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true
  }
  return element instanceof HTMLElement && element.isContentEditable
}

function shouldLeaveFocusAlone(): boolean {
  return isEditable(document.activeElement) || !!document.querySelector('dialog[open]')
}

export function RouteOrientation() {
  const { pathname, hash } = useLocation()
  const navigationType = useNavigationType()
  const previousPathname = useRef<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    const isFirstRender = previousPathname.current === null
    const pathnameChanged = previousPathname.current !== pathname
    previousPathname.current = pathname
    if (!pathnameChanged) return

    const title = titleForPath(pathname)
    if (title) document.title = title

    // The first page load is the browser's to announce; focus stays where it puts it.
    if (isFirstRender || navigationType === 'POP' || hash) return

    setAnnouncement('')
    const started = performance.now()
    let frame = 0
    const findHeading = () => {
      if (shouldLeaveFocusAlone()) return
      const heading = document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1')
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
        heading.focus({ preventScroll: true })
        return
      }
      if (performance.now() - started < HEADING_WAIT_MS) {
        frame = requestAnimationFrame(findHeading)
      } else {
        setAnnouncement(document.title)
      }
    }
    frame = requestAnimationFrame(findHeading)
    return () => cancelAnimationFrame(frame)
  }, [pathname, hash, navigationType])

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  )
}
