import { useEffect, useRef } from "react";

/**
 * Make the browser's Back button close an overlay (report builder, export,
 * a deal's detail…) and return to the page underneath, instead of leaving it.
 *
 * While `active`, one history entry tagged with `key` sits on top of the stack.
 *  - Back pops it → `onClose()` runs.
 *  - Closing any other way (×, Esc, Cancel) quietly removes that entry again,
 *    so the next Back behaves normally.
 * The entry keeps React Router's own state (usr/key/idx) so the router stays
 * on the same page, and it survives React StrictMode's double mount in dev.
 */
export function useBackToClose(key: string, onClose: () => void, active = true, holdBack?: () => boolean) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** Returns true when Back must not close (work in progress: it asks first and the entry is put back). */
  const holdRef = useRef(holdBack);
  holdRef.current = holdBack;
  const mounted = useRef(false);
  const popped = useRef(false);

  useEffect(() => {
    if (!active) return;
    mounted.current = true;
    popped.current = false;
    const mine = () => (window.history.state as any)?.__overlay === key;
    if (!mine()) {
      const base = { ...((window.history.state as any) ?? {}) };
      delete base.__overlay;
      window.history.pushState({ ...base, __overlay: key }, "");
    }
    const onPop = () => {
      if (mine()) return;           // something above us was popped, we're still on top
      if (holdRef.current?.()) {
        // not closing (yet): put our entry back so Back keeps meaning "close this"
        const base = { ...((window.history.state as any) ?? {}) };
        delete base.__overlay;
        window.history.pushState({ ...base, __overlay: key }, "");
        return;
      }
      popped.current = true;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      mounted.current = false;
      window.removeEventListener("popstate", onPop);
      // Closed by the UI: take our entry back off — unless we re-mounted
      // (StrictMode) or another overlay has already stacked on top.
      window.setTimeout(() => {
        if (!mounted.current && !popped.current && mine()) window.history.back();
      }, 0);
    };
  }, [key, active]);
}