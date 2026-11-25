import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import {
  JOURNAL_CONNECTOR_REPLY_PROSE_BYTES,
  type JournalConnectorReplyCut
} from '../../shared/agent-session/journal/journal-connector-reply'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionTurnAssistantMessage } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { capAnswer } from '../connector-cloud/connector-snapshot'

// A restart continuation answers its claimed requests with the whole reply: the prose each restart
// of its chain cut partway, then its own (item 964). The cut prose rides on the continuation's claim,
// read once by the read that builds the claim, so a fill reads nothing and a chain of any length
// costs one claim's worth of text.

// Below this, the part before the restart isn't worth a cut of its own: the whole reply is cut.
const MIN_PREFIX_BYTES = 512

/** What a restart continuation's claim carries: its chain's earlier cuts' replies (the cut
 *  opener's own claim), then the reply this cut left partway, if any. Kept within the answer cap,
 *  cut visibly when the chain wrote more. A usage-limit cut's continuation carries nothing. */
export function carriedOf(
  journal: { items: readonly AgentJournalRenderItem[] },
  cut: JournalConnectorReplyCut,
  cutOpener: AgentJournalRenderItem | undefined
): { carried?: string[] } {
  if (cut.kind !== 'restart') {
    return {}
  }
  const { items } = journal
  const turnRow = items.findLast(
    (item) => readAgentJournalTurn(item.body)?.turnId === cut.turnId || item.itemId === cut.turnId
  )
  const reply = turnRow ? cutReply(items, turnRow.itemId) : undefined
  const chained = cutOpener?.body.kind === 'message' ? cutOpener.body.connectorClaim : undefined
  const carried = [...(chained?.carried ?? []), ...(reply ? [reply] : [])]
  if (carried.length === 0) {
    return {}
  }
  const joined = carried.join('\n\n')
  return {
    carried:
      Buffer.byteLength(joined) > JOURNAL_CONNECTOR_REPLY_PROSE_BYTES
        ? [capAnswer(joined, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES)]
        : carried
  }
}

/** The reply a cut turn was writing when the restart came: only when its last root row is its own
 *  prose. A turn cut inside a tool call had not begun its answer. */
function cutReply(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): string | undefined {
  const last = items.findLast(
    (item) =>
      isRootAgentJournalItem(item) &&
      item.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === turnItemId
  )
  if (last?.body.kind !== 'message' || last.body.role !== 'assistant') {
    return undefined
  }
  const prose = structuredAgentSessionTurnAssistantMessage(items, turnItemId)
  return prose.trim() ? prose : undefined
}

/** A continuation opener's claim's carried replies, for its turn's fill. */
export function claimCarried(opener: AgentJournalRenderItem | null | undefined): {
  carried?: readonly string[]
} {
  const carried = opener?.body.kind === 'message' ? opener.body.connectorClaim?.carried : undefined
  return carried?.length ? { carried } : {}
}

/** The carried replies, then the continuation's own, within the answer cap. Over it, the
 *  continuation's own words stay whole where they fit and the earlier part is cut, with the note
 *  a cut answer carries; nothing is left out without it. */
export function wholeAnswer(carried: readonly string[] | undefined, own: string): string {
  const prefix = (carried ?? []).filter((part) => part.trim()).join('\n\n')
  if (!prefix) {
    return own
  }
  const whole = `${prefix}\n\n${own}`
  if (Buffer.byteLength(whole) <= JOURNAL_CONNECTOR_REPLY_PROSE_BYTES) {
    return whole
  }
  const room = JOURNAL_CONNECTOR_REPLY_PROSE_BYTES - Buffer.byteLength(own) - 2
  return room >= MIN_PREFIX_BYTES
    ? `${capAnswer(prefix, room)}\n\n${own}`
    : capAnswer(whole, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES)
}
