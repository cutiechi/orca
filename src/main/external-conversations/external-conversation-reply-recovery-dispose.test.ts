import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'

// RR-C1-08: a recovery pass still reading when the host changes or connectors stop (dispose) must
// not watch, arm a timer or write once its read returns; a boot after it works as before.

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const owed: JournalConnectorReplyRow = {
  account: 'account-a',
  deliveryId: 'd1',
  conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
  sessionId: 'chat-1',
  epoch: 'e',
  messageId: 'm1',
  queued: false
}

/** A chat whose journal reads wait until released, counting its live subscriptions. */
function heldChat() {
  const reads: (() => void)[] = []
  const chat = {
    subscribed: 0,
    live: 0,
    conversation: async () => ({}),
    journalReads: async () => ({
      canonicalItemIds: async (ids: readonly string[]) =>
        ids.map((itemId) => ({ itemId, canonicalItemId: itemId })),
      operationWindow: () =>
        new Promise((resolve) =>
          reads.push(() =>
            resolve({
              snapshot: {
                sessionId: 'chat-1',
                cursor: { epoch: 'e', sequence: 1 },
                items: [],
                submissions: []
              },
              complete: true
            })
          )
        )
    }),
    observeJournalPublications: () => {
      chat.subscribed += 1
      chat.live += 1
      return () => {
        chat.live -= 1
      }
    }
  }
  return { chat, release: () => reads.splice(0).forEach((resolve) => resolve()) }
}

function recoveryOver(current: () => ReturnType<typeof heldChat>['chat']) {
  const fills: unknown[] = []
  const journal: Pick<ConnectorReplyCutJournal, 'read' | 'fillOutcomes'> = {
    read: async () => [owed],
    fillOutcomes: async (rows) => (fills.push(...rows), false)
  }
  const recovery = new ConnectorReplyRecovery({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery reads and fills only.
    journal: () => journal as ConnectorReplyCutJournal,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only these chat members.
    chat: () => current() as never,
    hasSession: () => true,
    isBot: () => false,
    agentOf: () => 'claude',
    fillTurn: async () => ({ covered: new Set(), paused: false }),
    filled: () => {},
    continuationsSettled: Promise.resolve()
  })
  return { recovery, fills }
}

it('leaves no watch or timer on the old host when its pending read returns after a host change', async () => {
  const old = heldChat()
  const next = heldChat()
  let current = old.chat
  const { recovery, fills } = recoveryOver(() => current)
  const booting = recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  recovery.dispose()
  current = next.chat
  old.release()
  await booting
  expect([old.chat.subscribed, old.chat.live, vi.getTimerCount(), fills.length]).toEqual([
    0, 0, 0, 0
  ])
  // The new host's boot works as before: its owed row is watched there.
  const rebooting = recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  next.release()
  await rebooting
  expect([next.chat.subscribed, next.chat.live]).toEqual([1, 1])
})

it('leaves no watch or timer when connectors stop while the read is pending', async () => {
  const held = heldChat()
  const { recovery } = recoveryOver(() => held.chat)
  const booting = recovery.boot()
  await vi.advanceTimersByTimeAsync(0)
  recovery.dispose()
  held.release()
  await booting
  await vi.advanceTimersByTimeAsync(5_000)
  expect([held.chat.subscribed, held.chat.live, vi.getTimerCount()]).toEqual([0, 0, 0])
})
