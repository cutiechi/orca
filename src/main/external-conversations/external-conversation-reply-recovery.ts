import type { AgentJournalSubmission } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type {
  AgentJournalConnectorClaim,
  AgentJournalConnectorDelivery
} from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type {
  JournalConnectorReplyCut,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import { connectorFailure } from './external-conversation-failure'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import type { ConversationReplyFill } from './external-conversation-reply-fill'
import { fillRecoveredTurn } from './external-conversation-reply-turn-fill'
import {
  claimCut,
  readReplyEvidence,
  rowVerdict,
  turnVerdictOf
} from './external-conversation-reply-evidence'
import { PROCESS_STARTED_AT, staleCloser } from './external-conversation-reply-freshness'
import { fillVerdicts } from './external-conversation-reply-verdict-fills'

// Design item 125 §3: rows a live turn end didn't fill. Boot fills them from the journal, and a
// watch on each such chat settles the rest as its journal moves (withdrawn cards fill in their own
// transaction; it only wakes the sender).

// Chats opened at once by the boot scan (O15).
const OPEN_AT_ONCE = 2
// A watched chat's journal moves with every streamed token; it is settled once it pauses.
const SETTLE_AFTER_MS = 2_000

export type ReplyRecoveryChat = {
  conversation(sessionId: string): Promise<unknown>
  journalReads(
    sessionId: string
  ): Promise<Pick<JournalSqlReads, 'canonicalItemIds' | 'operationWindow'>>
  observeJournalPublications(sessionId: string, observer: () => void): () => void
}

type Unfilled = JournalConnectorReplyRow

export class ConnectorReplyRecovery {
  private readonly watches = new Map<string, () => void>()
  private readonly settling = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  // Chats owing a usage-limit pause: its end (a cancel, the setting, a closed chat) moves no journal,
  // only the chat's status.
  private readonly paused = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  // Until this start's own continuations of restart cuts settled, a cut may still be claimed.
  private continuationsSettled: boolean
  private readonly startedAt = Date.now()
  // Bumped by dispose: a pass begun before it is stale.
  private generation = 0

  constructor(
    private readonly deps: {
      journal: () => ConnectorReplyCutJournal | null
      chat: () => ReplyRecoveryChat | null
      /** Whether the chat still exists. */
      hasSession: (sessionId: string) => boolean
      /** Whether the chat is a bot's conversation, whose quiet marker means nothing to tell. */
      isBot: (sessionId: string) => boolean
      /** The chat's agent, which names it in the failure a source shows. */
      agentOf: (sessionId: string) => string
      fillTurn: ConversationReplyFill
      /** Rows were filled: wake the sender. */
      filled: () => void
      /** Whether a usage-limit cut's requests still wait for its automatic continue. */
      usageLimitDisposition?: (sessionId: string, turnItemId: string) => Promise<string | undefined>
      /** Settles once this start continued what the last run cut, or left it to a person. */
      continuationsSettled?: Promise<unknown>
      /** When this process started (PROCESS_STARTED_AT): a request admitted earlier crossed a restart. */
      processStartedAt?: number
      /** Rows held for an empty turn's retry still being sent: its send settles them. */
      retrySending?: (row: Unfilled) => boolean
    }
  ) {
    this.continuationsSettled = deps.continuationsSettled === undefined
    void deps.continuationsSettled?.then(
      () => this.settleCuts(),
      () => this.settleCuts()
    )
  }

  // Every watched chat is settled again: its cuts can close now.
  private settleCuts(): void {
    this.continuationsSettled = true
    for (const sessionId of this.watches.keys()) {
      this.later(sessionId)
    }
  }

  /** One pass over every row: filled ones go, unfilled chats are opened two at a time and settled. */
  async boot(): Promise<void> {
    const rows =
      (await this.deps
        .journal()
        ?.read()
        .catch((): JournalConnectorReplyRow[] => [])) ?? []
    if (rows.some((row) => row.fill)) {
      this.deps.filled()
    }
    const sessions = [...new Set(rows.filter((row) => !row.fill).map((row) => row.sessionId))]
    const next = async (): Promise<void> => {
      for (let sessionId = sessions.shift(); sessionId; sessionId = sessions.shift()) {
        await this.settle(sessionId, true)
      }
    }
    await Promise.all(Array.from({ length: OPEN_AT_ONCE }, next))
  }

  /** Stops every watch: another host, or connectors off. A pass still reading finishes as nothing. */
  dispose(): void {
    this.generation += 1
    this.watches.forEach((release) => release())
    this.watches.clear()
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
    this.paused.clear()
  }

  /** A request was admitted to this chat: its journal is watched from now on, subscribed before the
   *  first read, so a withdrawal, rejection or turn end while nothing else listens still settles it. */
  admitted(sessionId: string): void {
    const chat = this.deps.chat()
    if (chat) {
      this.watch(chat, sessionId)
      this.later(sessionId)
    }
  }

  /** A chat's turn ended: rows it left unfilled are watched from now on. */
  turnEnded(sessionId: string): void {
    this.later(sessionId)
  }

  private settle(sessionId: string, open = false): Promise<void> {
    const running = this.settling.get(sessionId)
    if (running) {
      this.again.add(sessionId)
      return running
    }
    const pass = (async () => {
      do {
        this.again.delete(sessionId)
        await this.settleOnce(sessionId, open).catch((error: unknown) =>
          console.warn('[connector] could not settle reply outbox rows', error)
        )
      } while (this.again.has(sessionId))
    })().finally(() => this.settling.delete(sessionId))
    this.settling.set(sessionId, pass)
    return pass
  }

  private async settleOnce(sessionId: string, open: boolean): Promise<void> {
    // A pass that outlived a dispose (another host, connectors off) writes and watches nothing.
    const generation = this.generation
    const live = () => generation === this.generation
    const journal = this.deps.journal()
    const chat = this.deps.chat()
    if (!journal || !chat) {
      return
    }
    const sending = this.deps.retrySending ?? (() => false)
    const unfilled = (await journal.read(sessionId)).filter((row) => !row.fill && !sending(row))
    if (!live()) {
      return
    }
    if (unfilled.length === 0) {
      this.unwatch(sessionId)
      this.deps.filled()
      return
    }
    const closer = staleCloser(this.deps.processStartedAt ?? PROCESS_STARTED_AT)
    if (!this.deps.hasSession(sessionId)) {
      await fillVerdicts(
        journal,
        sessionId,
        unfilled.map((row) => ({ row, verdict: { outcome: 'not_found' } })),
        [],
        closer
      )
      if (!live()) {
        return
      }
      this.unwatch(sessionId)
      this.deps.filled()
      return
    }
    if (open) {
      // Opening runs death settlement, so a turn the quit cut short reads interrupted.
      await chat.conversation(sessionId)
    }
    if (!live()) {
      return
    }
    const view = await readReplyEvidence(chat, sessionId, unfilled, (submission) =>
      this.rejectionOf(sessionId, submission)
    )
    if (!live()) {
      return
    }
    const { snapshot } = view
    const turns = view.turns()
    // Requests a turn with no verdict yet claims: owed and watched until it has one (O3). Requests
    // a cut turn claims: owed to a continuation until this start's own continuations settled.
    const unresolved: AgentJournalConnectorDelivery[] = []
    const cut: AgentJournalConnectorDelivery[] = []
    for (const turn of turns) {
      if (!live()) {
        return
      }
      const verdict = await fillRecoveredTurn(chat, sessionId, snapshot, turn, this.deps)
      ;(verdict.kind === 'cut' ? cut : unresolved).push(...verdict.stamps)
    }
    const idle = !turns.some((turn) => readAgentJournalTurn(turn.body)?.state === 'running')
    const lastEnded = Math.max(
      0,
      ...turns.filter((turn) => turnVerdictOf(turn) !== null).map((turn) => turn.sequence)
    )
    const settled = this.continuationsSettled
    const left = (await journal.read(sessionId)).filter((row) => !row.fill && !sending(row))
    const endedCuts = new Set<string>()
    const paused = left.flatMap((row) =>
      row.cut?.kind === 'usage_limit' && row.claimMessageId === undefined ? [row.cut.turnId] : []
    )
    for (const turnItemId of new Set(paused)) {
      const disposition = await this.deps.usageLimitDisposition?.(sessionId, turnItemId)
      // Ambiguous with the row unclaimed: the continue was never admitted (a claim commits with it).
      if (disposition === 'ended' || disposition === 'ambiguous') {
        endedCuts.add(turnItemId)
      }
    }
    const evidence = (row: Unfilled) =>
      rowVerdict(row, {
        view,
        cut,
        unresolved,
        settled,
        endedCuts,
        idle,
        lastEnded,
        startedAt: this.startedAt,
        rejectionOf: (submission) => this.rejectionOf(sessionId, submission)
      })
    const fills = left.flatMap((row) => {
      const verdict = evidence(row)
      return verdict ? [{ row, verdict }] : []
    })
    if (!live()) {
      return
    }
    await fillVerdicts(journal, sessionId, fills, snapshot.items, closer)
    const owed = (await journal.read(sessionId)).filter((row) => !row.fill)
    if (!live()) {
      return
    }
    if (owed.length > 0) {
      this.watch(chat, sessionId)
      if (owed.some((row) => row.cut?.kind === 'usage_limit' && !row.claimMessageId)) {
        this.paused.add(sessionId)
      } else {
        this.paused.delete(sessionId)
      }
    } else {
      this.paused.delete(sessionId)
      this.unwatch(sessionId)
    }
    this.deps.filled()
  }

  /** A continuation about to be sent for a cut of this chat (Phase 1 §1.4): claimCut. */
  async claimFor(
    sessionId: string,
    cut: JournalConnectorReplyCut
  ): Promise<AgentJournalConnectorClaim | undefined> {
    const journal = this.deps.journal()
    const chat = this.deps.chat()
    return journal && chat
      ? await claimCut(journal, chat, sessionId, cut, (submission) =>
          this.rejectionOf(sessionId, submission)
        )
      : undefined
  }

  /** A typed rejection says why, as the live end would. */
  private rejectionOf(
    sessionId: string,
    submission: AgentJournalSubmission
  ): { failure?: ConnectorFailure } {
    const fact = readAgentSessionFailureFact(submission.rejection)
    const failure = fact && connectorFailure(fact, this.deps.agentOf(sessionId))
    return failure ? { failure } : {}
  }

  private watch(chat: ReplyRecoveryChat, sessionId: string): void {
    if (!this.watches.has(sessionId)) {
      this.watches.set(
        sessionId,
        chat.observeJournalPublications(sessionId, () => this.later(sessionId))
      )
    }
  }

  /** A chat's status was published, or its continue's scheduler says it may have ended (none
   *  named: every chat): a pause it owes may have ended. */
  statusChanged(sessionId?: string): void {
    for (const id of sessionId === undefined ? [...this.paused] : [sessionId]) {
      if (this.paused.has(id)) {
        this.later(id)
      }
    }
  }

  private later(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId))
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      void this.settle(sessionId)
    }, SETTLE_AFTER_MS)
    timer.unref?.()
    this.timers.set(sessionId, timer)
  }

  private unwatch(sessionId: string): void {
    this.watches.get(sessionId)?.()
    this.watches.delete(sessionId)
  }
}
