/** Only the primary mouse/stylus button may start a panel drag. */
export function isPrimaryPanelPointer(button: number): boolean {
  return button === 0
}
