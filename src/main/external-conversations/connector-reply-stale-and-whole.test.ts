import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalConnectorClaim } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { readJournalConnectorReplies } from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-read'
import {
  admit,
  asked,
  installReplyMatrix,
  NOW,
  start,
  stampOf
} from './connector-reply-matrix.test-fixture'
import { claimCarried, wholeAnswer } from './external-conversation-whole-answer'
import { ANSWER_CUT_NOTE } from '../connector-cloud/connector-snapshot'

// Item 964, on the restart matrix's real journal: a fill too old to post closes its request quietly,
// and a restart continuation answers with the whole reply, the part the cut left first.

installReplyMatrix()

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const continueBody = (claim: AgentJournalConnectorClaim): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue.' }],
  connectorClaim: claim
})

type Process = ReturnType<typeof start>

/** A process filling at this time on the fake clock, started by a restart just before it; its
 *  requests were admitted at NOW, before that restart. */
function startAt(at: number, options: Parameters<typeof start>[0] = {}): Process {
  vi.setSystemTime(at)
  return start({ processStartedAt: at - MINUTE, ...options })
}

/** Why each row closed quietly, if it did. */
const reasons = (p: Process) =>
  Object.fromEntries(
    readJournalConnectorReplies(p.db).map((row) => [
      row.deliveryId,
      row.fill?.expiredReason ?? null
    ])
  )

/** m1 asked d1; the turn it opened was cut, and a launch continuation c1 claimed the request. */
async function cutAndClaimed(p: Process, cutProse?: string) {
  admit(p.db, 'm1', asked('d1'))
  p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted', cutProse)])
  const claim = await p.recovery.claimFor('chat-1', { turnId: 'provider-item:t1', kind: 'restart' })
  admit(p.db, 'c1', continueBody(claim!))
  return claim!
}

/** The continuation's live turn end, as the turn-end watch fills it. */
const continuationEnded = (p: Process, claim: AgentJournalConnectorClaim, prose: string) =>
  p.fillTurn({
    sessionId: 'chat-1',
    turnItemId: 'item:t2',
    stamps: claim.origin,
    openerItemId: agentJournalSubmissionKey('c1'),
    // As the live end reads it: the opener's stored claim.
    ...claimCarried(p.message('c1')),
    outcome: 'success',
    prose,
    bot: false,
    links: []
  })

describe('a fill too old to post', () => {
  it('closes quietly when recovery finds an answer whose turn ended over an hour ago', async () => {
    const p = startAt(NOW + 2 * HOUR, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed', 'Done yesterday.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
    expect(reasons(p).d1).toMatch(/^stale_answer: answered ended at /)
  })

  it('still posts an answer recovery finds within the hour', async () => {
    const p = startAt(NOW + 10 * MINUTE, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed', 'Done just now.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Done just now.', head: 'd1' }
    })
    expect(reasons(p).d1).toBeNull()
  })

  it('closes quietly when a restart continuation answers a request admitted over a day ago', async () => {
    const p = startAt(NOW + 25 * HOUR)
    const claim = await cutAndClaimed(p)
    await continuationEnded(p, claim, 'Finished after the restart.')
    expect(p.outcomes()).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
    expect(reasons(p).d1).toMatch(/^old_request: answered for a request admitted at /)
  })

  it('posts a restart continuation’s answer to a request with no admission date of its own', async () => {
    const p = startAt(NOW + 25 * HOUR)
    const claim = await cutAndClaimed(p)
    // A row an older build wrote carries no date: a missing date never loses an answer.
    p.db.exec('UPDATE journal_connector_replies SET admitted_at=NULL')
    await continuationEnded(p, claim, 'Finished after the restart.')
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Finished after the restart.', head: 'd1' }
    })
  })

  it('closes a day-old cut quietly instead of telling the thread it was interrupted', async () => {
    const p = startAt(NOW + 25 * HOUR, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
    expect(reasons(p).d1).toMatch(/^old_request: interrupted /)
  })

  it('still tells a usage-limit pause’s request how it ended, however old', async () => {
    let disposition = 'pending'
    const p = startAt(NOW + 3 * 24 * HOUR, {
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => disposition
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    await p.limited('item:t1', 'm1', [stampOf('d1')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    // The thread was told the work resumes later: its end is told whenever it comes.
    disposition = 'ended'
    p.recovery.statusChanged('chat-1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'failed', head: 'd1', category: 'usage_limit' }
    })
  })
})

describe('a restart continuation’s whole answer', () => {
  it('answers with the reply the restart cut partway, then the continuation’s', async () => {
    const p = start()
    const claim = await cutAndClaimed(p, 'Here is the first half of the plan.')
    await continuationEnded(p, claim, 'And here is the second half.')
    expect(p.outcomes()).toEqual({
      d1: {
        outcome: 'answered',
        prose: 'Here is the first half of the plan.\n\nAnd here is the second half.',
        head: 'd1'
      }
    })
  })

  it('answers with the continuation’s alone when the cut came inside a tool call', async () => {
    const p = start()
    admit(p.db, 'm1', asked('d1'))
    const [said, cut] = p.turn('item:t1', 'm1', 'interrupted', 'Let me check the logs.')
    const tool: AgentJournalRenderItem = {
      itemId: 'tool-t1',
      revision: 1,
      sequence: said!.sequence,
      observedAt: said!.observedAt,
      body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'running' },
      turnScope: { kind: 'turn', turnItemId: 'item:t1' }
    }
    p.show([p.message('m1'), { ...said!, sequence: said!.sequence - 1 }, tool, cut!])
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', continueBody(claim!))
    await continuationEnded(p, claim!, 'The logs show the fix worked.')
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'The logs show the fix worked.', head: 'd1' }
    })
  })

  it('carries all five cuts of a five-restart chain, with no cut dropped', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    let claim = await cutAndClaimed(p, 'Part 1.')
    // Each continuation c1..c4 is cut in turn, partway through its own part.
    for (let hop = 1; hop <= 4; hop += 1) {
      p.show([
        ...p.items(),
        p.message(`c${hop}`),
        ...p.turn(`item:t${hop + 1}`, `c${hop}`, 'interrupted', `Part ${hop + 1}.`)
      ])
      const next = await p.recovery.claimFor('chat-1', {
        turnId: `provider-item:t${hop + 1}`,
        kind: 'restart'
      })
      expect(next?.origin).toEqual(claim.origin)
      claim = next!
      admit(p.db, `c${hop + 1}`, continueBody(claim))
    }
    p.show([...p.items(), p.message('c5'), ...p.turn('item:t6', 'c5', 'completed', 'Done.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: {
        outcome: 'answered',
        prose: 'Part 1.\n\nPart 2.\n\nPart 3.\n\nPart 4.\n\nPart 5.\n\nDone.',
        head: 'd1'
      }
    })
  })

  it('carries every cut of a chain, oldest first', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    const first = await cutAndClaimed(p, 'Step one is done.')
    p.show([
      ...p.items(),
      p.message('c1'),
      ...p.turn('item:t2', 'c1', 'interrupted', 'Step two too.')
    ])
    const second = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t2',
      kind: 'restart'
    })
    expect(second?.origin).toEqual(first.origin)
    admit(p.db, 'c2', continueBody(second!))
    p.show([...p.items(), p.message('c2'), ...p.turn('item:t3', 'c2', 'completed', 'All three.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: {
        outcome: 'answered',
        prose: 'Step one is done.\n\nStep two too.\n\nAll three.',
        head: 'd1'
      }
    })
  })

  it('adds nothing to a continuation that ended without an answer', async () => {
    const p = start()
    const claim = await cutAndClaimed(p, 'Half an answer.')
    await continuationEnded(p, claim, '')
    expect(p.outcomes()).toEqual({ d1: { outcome: 'no_answer', head: 'd1' } })
  })
})

describe('RR-C1-05/06: the whole answer reads nothing at fill, and is never silently cut', () => {
  it('takes the cut prose from the continuation’s stored claim, with the journal window empty', async () => {
    const p = start()
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted', 'First half.')])
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    expect(claim?.carried).toEqual(['First half.'])
    admit(p.db, 'c1', continueBody(claim!))
    const opener = p.message('c1')
    p.show([])
    await p.fillTurn({
      sessionId: 'chat-1',
      turnItemId: 'item:t2',
      stamps: claim!.origin,
      openerItemId: opener.itemId,
      ...claimCarried(opener),
      outcome: 'success',
      prose: 'Second half.',
      bot: false,
      links: []
    })
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'First half.\n\nSecond half.', head: 'd1' }
    })
  })

  it('keeps the continuation’s own words whole over the cap, cutting the earlier part with its note', () => {
    const own = 'Conclusion.'
    const answer = wholeAnswer(['a'.repeat(40 * 1024)], own)
    expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(32 * 1024)
    expect(answer.endsWith(`${ANSWER_CUT_NOTE}\n\n${own}`)).toBe(true)
  })

  it('cuts the whole reply with its note when the continuation’s own words fill the cap', () => {
    const answer = wholeAnswer(['Earlier.'], 'b'.repeat(32 * 1024))
    expect(answer.startsWith('Earlier.\n\n')).toBe(true)
    expect(answer.endsWith(ANSWER_CUT_NOTE)).toBe(true)
    expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(32 * 1024)
  })
})
