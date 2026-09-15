/**
 * Keeps overlays visible while the player is in browser fullscreen.
 *
 * When an element is fullscreened, the browser renders that element and its
 * descendants and nothing else. Every modal in this app is a sibling of
 * `#video-stage`, not a child, so entering fullscreen made all of them
 * invisible -- the remote, the series explorer, the quarantine list, even the
 * confirm dialog. The buttons still worked and still toggled `hidden`; the
 * markup simply was not being painted.
 *
 * The fix is to move the overlay into the fullscreen element while fullscreen
 * lasts, and put it back afterwards. Doing it centrally, driven by the `hidden`
 * class the modals already use, means no call site has to know about it -- which
 * matters here because several modals are opened from inline `onclick`
 * attributes in index.html.
 *
 * This is deliberately a no-op when `document.fullscreenElement` is null, so the
 * Android path -- which fakes fullscreen with a CSS class and an immersive
 * system-UI call, and never restricts the DOM -- is left completely alone.
 */

const MODAL_IDS = [
  'modal-remote',
  'modal-series-explorer',
  'modal-movie-explorer',
  'modal-quarantine',
  'modal-tv-select-picker',
  'modal-app-dialog',
  'modal-m3u'
];

/** Where a modal lived before it was hoisted, so it can be put back exactly. */
interface Anchor {
  parent: Node;
  nextSibling: Node | null;
}

const anchors = new Map<string, Anchor>();

/**
 * Guards against the observer re-entering its own work.
 *
 * sync() moves nodes and toggles a class; both are mutations the observer is
 * watching for, so without this the first hoist feeds straight back into
 * another sync and the loop saturates the main thread -- the page stops
 * responding entirely rather than merely misbehaving.
 */
let syncing = false;

function isVisible(el: Element): boolean {
  return !el.classList.contains('hidden');
}

/** Moves one modal into the fullscreen element, remembering where it came from. */
function hoist(el: HTMLElement, target: Element): void {
  if (el.parentElement === target) return;
  if (!anchors.has(el.id) && el.parentNode) {
    anchors.set(el.id, { parent: el.parentNode, nextSibling: el.nextSibling });
  }
  // Nothing below is reached for an already-hoisted modal, so the class and the
  // move happen exactly once per fullscreen session.

  // The fullscreen element establishes its own stacking context, so the
  // overlay needs to sit above the video inside it rather than relying on
  // whatever z-index worked in the document.
  el.classList.add('fs-hoisted');
  target.appendChild(el);
}

/** Returns one modal to the position it held in the document. */
function restore(el: HTMLElement): void {
  const anchor = anchors.get(el.id);
  // Touch the class only when it is actually set: an unconditional remove()
  // still counts as a write on some engines and would feed the observer.
  if (el.classList.contains('fs-hoisted')) el.classList.remove('fs-hoisted');
  if (!anchor) return;
  anchors.delete(el.id);
  try {
    anchor.parent.insertBefore(el, anchor.nextSibling);
  } catch {
    // The anchor is gone (the subtree was re-rendered). Appending to the
    // recorded parent still beats leaving the modal inside a stage that is no
    // longer fullscreen.
    try {
      anchor.parent.appendChild(el);
    } catch {
      /* nothing sensible left to do */
    }
  }
}

/** Hoists every visible modal, or restores all of them when not fullscreen. */
function sync(): void {
  if (syncing) return;
  syncing = true;
  try {
    syncInner();
  } finally {
    syncing = false;
  }
}

function syncInner(): void {
  const target = document.fullscreenElement;

  for (const id of MODAL_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;

    if (target && isVisible(el)) {
      hoist(el, target);
    } else if (!target || !isVisible(el)) {
      // A hidden modal is returned too: leaving it parented to the stage would
      // strand it there the moment fullscreen ends.
      restore(el);
    }
  }
}

export function initFullscreenModals(): void {
  if (typeof document === 'undefined') return;

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync as EventListener);

  // The modals are shown and hidden by toggling a class, from many call sites
  // including inline onclick attributes. Watching the attribute catches all of
  // them without every caller needing to cooperate.
  const observer = new MutationObserver(records => {
    if (!document.fullscreenElement) return;
    for (const record of records) {
      const el = record.target as HTMLElement;
      if (el instanceof HTMLElement && MODAL_IDS.includes(el.id)) {
        sync();
        return;
      }
    }
  });

  for (const id of MODAL_IDS) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  sync();
}
