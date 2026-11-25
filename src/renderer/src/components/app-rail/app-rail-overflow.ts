/** One rail button (28px) plus its 10px gap; two groups with 20px between them use exactly one slot per button. */
export const APP_RAIL_SLOT_PX = 38

/** Whole slots that fit in the toolbar's content height (padding already excluded). */
export function appRailSlotCapacity(contentHeightPx: number): number {
  return Math.max(0, Math.floor(contentHeightPx / APP_RAIL_SLOT_PX))
}

export type AppRailPartition = {
  /** Destinations kept on the rail, from the top; the rest go into More in order. */
  shownDestinations: number
  more: boolean
}

/**
 * Fit Workspaces, the destinations and the account button into `capacity` slots. When they don't all fit, More takes
 * a slot and destinations fold into it from the bottom of the top group up. Workspaces, More and the account button
 * stay (the floor); the account button never folds, and the rail never scrolls.
 */
export function partitionAppRail(destinationCount: number, capacity: number): AppRailPartition {
  // With nothing to fold, an empty More would only cost a slot.
  if (destinationCount === 0 || 1 + destinationCount + 1 <= capacity) {
    return { shownDestinations: destinationCount, more: false }
  }
  return {
    shownDestinations: Math.min(destinationCount, Math.max(0, capacity - 3)),
    more: true
  }
}
