/*
 * Backward-compatible wrapper.
 * Phase A moves the application chrome to AppLayout in App.jsx.
 * Existing pages that still import MISPageShell can keep doing so without
 * creating a second header/sidebar/footer.
 */
export default function MISPageShell({ children }) {
  return children
}
