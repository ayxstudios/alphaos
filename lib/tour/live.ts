/**
 * True while the guided tour is walking someone through the screen. Buttons
 * that change a real order (approve, send back, reassign) check this, so a
 * press during the tour shows what it does without changing anything.
 */
export function tourIsRunning(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector('[data-tour-mode="try"], [data-tour-mode="one"]');
}
