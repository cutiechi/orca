import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { heldHeads } from './external-conversation-reply-empty-retry'
import { expectOf, type ReplyRecoveryVerdict } from './external-conversation-reply-evidence'
import type { StaleCloser } from './external-conversation-reply-freshness'

// Recovery's writes of the rows its evidence settles: each with its verdict, held answers under one
// head, and a request too old to post closed quietly under its own key, never keying another's
// answer (item 964).

export async function fillVerdicts(
  journal: ConnectorReplyJournal,
  sessionId: string,
  verdicts: readonly { row: JournalConnectorReplyRow; verdict: ReplyRecoveryVerdict }[],
  items: readonly AgentJournalRenderItem[],
  closer: StaleCloser
): Promise<void> {
  if (verdicts.length === 0) {
    return
  }
  const fills = verdicts.map((entry) => ({
    ...entry,
    stale: closer.isStale(entry.row, entry.verdict.endedAt)
  }))
  const heads = heldHeads(
    fills.flatMap(({ row, verdict, stale }) =>
      !stale && (verdict.outcome === 'no_answer' || verdict.prose) ? [row] : []
    ),
    items
  )
  await journal
    .fillOutcomes(
      fills.map(({ row, verdict, stale }) => {
        const fill = {
          account: row.account,
          deliveryId: row.deliveryId,
          outcome: verdict.outcome,
          answerDeliveryId: (!stale && heads.get(row)) || row.deliveryId,
          ...expectOf(row),
          ...(verdict.failure ? { failure: verdict.failure } : {}),
          ...(verdict.prose ? { prose: verdict.prose } : {})
        }
        return stale ? closer.close(row, fill, verdict.endedAt) : fill
      })
    )
    .finally(() => closer.report(journal, sessionId))
}
