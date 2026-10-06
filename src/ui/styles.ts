/**
 * Button classes, defined once.
 *
 * Every interactive control in the app routes through these, so touch target
 * size, disabled affordance and focus visibility cannot drift per screen. The
 * previous state was each button carrying its own className, and most had
 * neither a minimum height nor a visible disabled state.
 *
 * Sizes follow the platform targets: 44px on touch (iOS), 48px on Android
 * (Material). Desktop pointers need less, but a reader may be on a tablet, so
 * the default clears 44 and only the dense toolbar relaxes it — and never below
 * 32, which is the practical floor for a precision pointer.
 */

export const BTN_BASE =
  "inline-flex select-none items-center justify-center gap-1.5 rounded-lg font-medium " +
  "transition-colors duration-150 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  // Disabled must not be confused with normal: dimmed, not-allowed cursor, and
  // no hover response.
  "disabled:pointer-events-none disabled:opacity-45 disabled:cursor-not-allowed";

/** Default: 44px tall. Use for anything a learner taps to act. */
export const BTN = `${BTN_BASE} min-h-11 px-4 py-2 text-sm`;

/** Dense: 32px. Toolbar chrome only — never for a primary action. */
export const BTN_SM = `${BTN_BASE} min-h-8 px-2.5 py-1 text-[13px]`;

/** Icon-only: square, must carry an aria-label from the caller. */
export const BTN_ICON = `${BTN_BASE} h-11 w-11 p-0`;

/**
 * Primary: filled with the accent, white label (7.3:1).
 * One per view — the single most important action on the screen.
 */
export const BTN_PRIMARY = `${BTN} bg-accent text-white hover:bg-accent/90 active:bg-accent`;

/**
 * Secondary: outlined. Distinguished from primary by fill AND weight, never by
 * colour alone, so the two are still distinguishable in greyscale or with any
 * colour-vision deficiency.
 */
export const BTN_SECONDARY = `${BTN} border border-line bg-paper text-ink hover:border-ink-soft hover:bg-shell`;

/** Quiet: text only. For destructive or low-stakes actions a screen is full of. */
export const BTN_QUIET = `${BTN_BASE} min-h-11 px-3 py-2 text-sm text-ink-soft hover:bg-shell hover:text-ink`;

/** Secondary metadata. 13px, still above the 12px floor. */
export const META = "text-[13px] leading-relaxed text-ink-soft";