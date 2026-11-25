import { describe, expect, it } from 'vitest'
import { partitionAppRail } from './app-rail-overflow'

describe('partitionAppRail', () => {
  it('shows every destination with no More when Workspaces, destinations and the account button fit', () => {
    expect(partitionAppRail(5, 7)).toEqual({ shownDestinations: 5, more: false })
    expect(partitionAppRail(5, 20)).toEqual({ shownDestinations: 5, more: false })
  })

  it('folds destinations from the bottom into More, keeping Workspaces, More and the account button', () => {
    // 6 slots: Workspaces + More + account leave 3 for destinations.
    expect(partitionAppRail(5, 6)).toEqual({ shownDestinations: 3, more: true })
    expect(partitionAppRail(5, 4)).toEqual({ shownDestinations: 1, more: true })
  })

  it('never folds the account button, even when nothing else fits', () => {
    expect(partitionAppRail(5, 3)).toEqual({ shownDestinations: 0, more: true })
    expect(partitionAppRail(5, 0)).toEqual({ shownDestinations: 0, more: true })
  })

  it('shows no empty More when there are no destinations to fold', () => {
    expect(partitionAppRail(0, 0)).toEqual({ shownDestinations: 0, more: false })
    expect(partitionAppRail(0, 1)).toEqual({ shownDestinations: 0, more: false })
  })
})
