import { useEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * Scrolls to the top of the page when the user navigates to a new page.
 *
 * Browsers keep the current scroll position across SPA (pushState) navigations,
 * so clicking a link halfway down a page used to drop you halfway down the next
 * page. React Router has no built-in scroll reset when using <BrowserRouter>.
 *
 * Three cases are deliberately left alone:
 * - POP (back/forward): the browser restores the previous scroll position itself.
 * - Same pathname: the search page rewrites `?q=` as you search, and yanking the
 *   page to the top mid-search would be worse than the bug this fixes.
 * - URLs with a hash: the target anchor decides where the page lands.
 */
export function ScrollToTop() {
  const { pathname, hash } = useLocation()
  const navigationType = useNavigationType()
  const previousPathname = useRef(pathname)

  useEffect(() => {
    const pathnameChanged = previousPathname.current !== pathname
    previousPathname.current = pathname

    if (!pathnameChanged) return
    if (navigationType === 'POP') return
    if (hash) return

    window.scrollTo(0, 0)
  }, [pathname, hash, navigationType])

  return null
}
