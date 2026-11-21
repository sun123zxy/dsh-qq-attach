/**
 * dsh-qq-attach host half.
 *
 * One DSH session attaches to one QQ chat. QQ input becomes user messages in
 * that session; assistant output and presented files go back; the agent gets
 * qq_send / qq_send_file only while attached.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { QQBot, historyBuffer, quoteRef, mentionGate } from '@tencent-connect/qqbot-nodejs'
import { startQrConnect } from '@tencent-connect/qqbot-connector'
import { z } from 'zod'
import { chunkText, isWithinRoot, mediaTypeOf, renderMentions, MEDIA_ROOT } from './lib/util.js'
import { downloadAttachment, sendMediaFile } from './lib/media.js'

export const name = 'qq-attach'

/** Bumped on every behavioural change; surfaced by the `status` endpoint. */
const BUILD = '0.8.4-credential-key'

export const inject = [
  'agents', 'sessions', 'sessionController', 'storageDomain', 'credentials',
  'webServer', 'systemPrompt', 'tools', 'sessionQuery', 'attachments', 'workspaceRegistry',
]

const Attach = z.object({
  sessionId: z.string(),
  autoReply: z.boolean(),
  streaming: z.boolean(),
  toolResults: z.boolean(),
  errors: z.boolean(),
  steer: z.boolean(),
  // Optional so records written before per-session prompts still load.
  prompt: z.string().optional(),
  createdAt: z.number(),
})
const Chat = z.object({ kind: z.string(), lastSeen: z.number() })
const Account = z.object({ appId: z.string(), updatedAt: z.number() })
const Settings = z.object({ prompt: z.string() })

const SPEC = {
  name: 'qq_attach',
  version: 1,
  tables: {
    attaches: { valueSchema: Attach },
    chats: { valueSchema: Chat },
    account: { valueSchema: Account },
    settings: { valueSchema: Settings },
  },
}

/**
 * Local user message constructor: no host package import needed.
 *
 * `role` is mandatory. Session records are replayed verbatim into provider
 * request bodies, so a message stored without `role` makes every later request
 * fail with `422 INVALID_REQUEST: messages[n]: missing field 'role'`.
 */
const createUserMessage = ({ content, source }) => Object.freeze({
  id: randomUUID(),
  role: 'user',
  content: Object.freeze(content),
  source,
})

const C2C_TTL = 30 * 60 * 1000
const GROUP_TTL = 5 * 60 * 1000
const RECENT_CHATS = 10
/**
 * Default prompt injected while automatic replies are off. Overridable from the
 * settings panel, so it states the delivery rule rather than a fixed cadence:
 * anything the user must know has to travel through qq_send, while unprompted
 * work should only report occasionally.
 */
const DEFAULT_PROMPT = 'This DSH session is attached to one QQ chat, and automatic replies are OFF for it. '
  + 'Nothing you write as a normal assistant reply is delivered to the user; only the qq_send tool reaches them. '
  + 'So anything the user needs to know has to be sent with qq_send yourself. When the user asked a question or '
  + 'requested an action, always answer them there, including refusals and failures. While you work on your own, '
  + 'do not interrupt them for every step: send an occasional short progress note instead. Use qq_send_file for '
  + 'files inside the session working directory.'

export async function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const domain = await ctx.storageDomain.open(SPEC)
  ctx.effect(() => () => { void domain.close() }, 'qq-attach: close domain')

  const attaches = domain.table('attaches')
  const chats = domain.table('chats')
  const account = domain.table('account')

  /** Prompt injected for one attached session: its own override, else the default. */
  const promptFor = (sessionId) => {
    const custom = bySession.get(sessionId)?.prompt?.trim()
    return custom ? custom : DEFAULT_PROMPT
  }

  const mediaEnabled = config.media?.enabled !== false
  const maxBytes = Math.max(1, Number(config.media?.maxMB ?? 200)) * 1024 * 1024
  const ttlHours = Math.max(0, Number(config.media?.ttlHours ?? 24))
  const maxFiles = Math.max(1, Number(config.sendFile?.maxFiles ?? 4))
  // How many buffered group messages are handed to the agent as context.
  const historyLimit = Math.max(0, Number(config.group?.historyLimit ?? 8))

  /** Whether a session is archived, which blocks every model step it proposes. */
  const isArchived = (sessionId) =>
    ctx.workspaceRegistry?.archivedSessionIds?.includes(sessionId) === true

  /** One entry per session id, derived from the attach table. */
  const bySession = new Map()
  const rebuild = () => {
    bySession.clear()
    for (const [target, value] of attaches.entries()) bySession.set(value.sessionId, { ...value, target })
  }
  rebuild()

  /**
   * Per-session QQ traffic log. The session trajectory already records what the
   * agent saw and did; this records what crossed the QQ boundary instead: raw
   * platform events, mention and attachment payloads, API calls and results.
   */
  const logs = new Map()
  const LOG_LIMIT = 400

  /** Collapse one value to a single log line, keeping the head of long content. */
  const brief = (value, max = 240) => {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max)}…` : flat
  }

  /** Append one line to a session's log, oldest entries dropped first. */
  const logLine = (sessionId, dir, event, text, detail) => {
    if (!sessionId) return
    const list = logs.get(sessionId) ?? []
    list.push({
      at: Date.now(),
      dir,
      event,
      text: String(text ?? ''),
      ...(detail === undefined ? {} : { detail }),
    })
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT)
    logs.set(sessionId, list)
  }

  /** Bot-wide events belong to every session that is currently attached. */
  const logAll = (dir, event, text) => {
    for (const sessionId of bySession.keys()) logLine(sessionId, dir, event, text)
  }

  /**
   * Mention id to readable handle. QQ identifies mentions by opaque openid, so the
   * only way to render a name is to learn it from `mentions[]` payloads first.
   * Ids that were never seen stay verbatim rather than being guessed.
   */
  const mentionNames = new Map()
  const botMentionIds = new Set()

  /** Record the ids and names carried by one inbound message. */
  const learnMentions = (msg) => {
    if (!Array.isArray(msg?.mentions)) return
    for (const mention of msg.mentions) {
      const id = mention?.member_openid ?? mention?.user_openid ?? mention?.id
      if (!id) continue
      if (mention?.is_you === true) { botMentionIds.add(id); continue }
      const name = mention?.nickname || mention?.username
      if (name) mentionNames.set(id, `@${name}`)
    }
  }

  /** Replacement for one mention id; undefined keeps the raw marker. */
  const resolveMention = (id) => {
    if (botMentionIds.has(id)) return '@you'
    return mentionNames.get(id)
  }

  /**
   * Attachment descriptors for messages that were not addressed to the bot. Those
   * are never downloaded; the map only lets history and the log say what arrived.
   */
  const attachmentNotes = new Map()
  const ATTACHMENT_NOTE_LIMIT = 200

  const noteFor = (messageId) => attachmentNotes.get(messageId) ?? []

  /** Human-readable placeholder for one attachment descriptor. */
  const attachmentLabel = (item) => {
    const name = item?.filename || item?.name || 'file'
    const type = String(item?.content_type ?? item?.contentType ?? '')
    if (type.startsWith('image/')) return `[image: ${name}]`
    if (type.startsWith('video/')) return `[video: ${name}]`
    if (type.startsWith('audio/') || type === 'voice') return `[voice: ${name}]`
    return `[file: ${name}]`
  }

  /** Gateway state from the SDK's own ready/disconnected events. */
  const link = { connected: false, readyAt: 0, disconnectedAt: 0, reason: null }

  /** Last inbound message id per target, for the passive reply window. */
  const lastMsg = new Map()
  const toolNames = new Map()
  const streams = new Map()
  const presented = new Map()
  const runtimes = new Map()

  await mkdir(MEDIA_ROOT, { recursive: true }).catch(() => {})

  let bot
  let botTask
  let botError
  let bindState = { phase: 'idle' }
  let stopBind
  const requireQr = createRequire(import.meta.url)
  let qrLib

  const targetOf = (msg) => msg.kind === 'group'
    ? (msg.groupOpenid ? `group:${msg.groupOpenid}` : undefined)
    : `c2c:${msg.senderId}`
  const parseTarget = (target) => {
    const at = String(target || '').indexOf(':')
    if (at <= 0) return undefined
    const scope = target.slice(0, at)
    const id = target.slice(at + 1)
    if ((scope !== 'c2c' && scope !== 'group') || !id) return undefined
    return { scope, targetId: id }
  }

  const passive = (target) => {
    const parts = parseTarget(target)
    const m = lastMsg.get(target)
    if (!m) return { ...parts }
    const ttl = parts.scope === 'c2c' ? C2C_TTL : GROUP_TTL
    if (Date.now() - m.at > ttl || m.count >= 4) return { ...parts }
    m.count += 1
    return { ...parts, msgId: m.msgId }
  }
  async function sendText(target, text) {
    const b = await botInstance()
    if (!b) throw new Error('QQ bot is not configured')
    for (const chunk of chunkText(text)) await b.sendMarkdown(passive(target), chunk)
  }

  // ---- credentials and bot lifecycle -------------------------------------

  /** DSH credential record keys must follow `<scope>/<id>`. */
  const CREDENTIAL_KEY = 'qq-attach/main'

  async function readSecret() {
    try {
      const record = await ctx.credentials.readRecord(CREDENTIAL_KEY)
      return record && record.kind === 'api-key' ? record.key : undefined
    } catch { return undefined }
  }

  async function botInstance() {
    if (bot) return bot
    if (botTask) return botTask
    botTask = (async () => {
      const saved = account.get('main')
      if (!saved?.appId) return undefined
      const secret = await readSecret()
      if (!secret) return undefined
      const created = new QQBot({ appId: saved.appId, appSecret: secret, logger: log })
      // Buffer first so skipped messages are still recorded, then resolve quotes,
      // then let the SDK decide whether this message addresses the bot. passthrough
      // keeps the chain alive for messages the gate rejects.
      created.use(historyBuffer({ limit: 50 }))
      created.use(quoteRef({
        // The default store keeps text only, which loses an image quote on a cache
        // hit. Keep the attachment descriptors so the image stays reachable.
        enrichEntry: (entry, ctx) => ({ ...entry, attachments: ctx.message.attachments ?? [] }),
      }))
      created.use(mentionGate({ passthrough: true, requireMentionInGroup: true }))
      created.on('ready', () => {
        link.connected = true
        link.readyAt = Date.now()
        link.reason = null
        logAll('sys', 'link', 'gateway ready')
      })
      created.on('disconnected', (event) => {
        link.connected = false
        link.disconnectedAt = Date.now()
        link.reason = event?.reason ?? event?.code ?? 'disconnected'
        logAll('sys', 'link', `gateway disconnected: ${link.reason}`)
      })
      created.on('message', (messageCtx, message) => { void onInbound(messageCtx, message) })
      // SDK start() is a long-lived promise: it never resolves while connected and
      // rejects only when the gateway gives up. Do not await it.
      created.start().catch((error) => {
        botError = error instanceof Error ? error.message : String(error)
        logAll('sys', 'error', `bot stopped: ${botError}`)
        log.warn(`qq-attach: bot stopped: ${botError}`)
        if (bot === created) bot = undefined
      })
      botError = undefined
      bot = created
      return bot
    })()
    try { return await botTask } finally { botTask = undefined }
  }

  async function restartBot() {
    const previous = bot
    bot = undefined
    cancelAllStreams()
    if (previous) { try { await previous.stop() } catch {} }
    await botInstance()
  }

  async function rememberChat(target, kind) {
    await chats.put(target, { kind, lastSeen: Date.now() })
    const rows = [...chats.entries()].sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    for (const [key] of rows.slice(RECENT_CHATS)) await chats.delete(key)
  }

  // ---- runtime: tools and prompt per attached agent ----------------------

  const qqSend = {
    name: 'qq_send',
    description: 'Send a text message to the QQ chat attached to this session. Use it when automatic replies are off or when you want to send something proactively.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Plain text to send to QQ.' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { sent: { type: 'boolean' }, target: { type: 'string' } },
        required: ['sent', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `sent to ${value.target}` }],
    },
    async execute(args, exec) {
      const att = bySession.get(exec.agent?.id)
      if (!att) throw new Error('this session is not attached to a QQ chat')
      const text = String(args?.text ?? '')
      if (!text.trim()) throw new Error('text must not be empty')
      try {
        await sendText(att.target, text)
        logLine(att.sessionId, 'out', 'qq_send', text)
      } catch (error) {
        logLine(att.sessionId, 'out', 'qq_send', `failed: ${error instanceof Error ? error.message : error}`)
        throw error
      }
      return { sent: true, target: att.target }
    },
  }

  const qqSendFile = {
    name: 'qq_send_file',
    description: 'Send a local file to the QQ chat attached to this session. The path must be inside the session working directory or the QQ media directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to an existing file.' } },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { sent: { type: 'boolean' }, target: { type: 'string' }, file: { type: 'string' } },
        required: ['sent', 'target', 'file'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `sent ${value.file} to ${value.target}` }],
    },
    async execute(args, exec) {
      const att = bySession.get(exec.agent?.id)
      if (!att) throw new Error('this session is not attached to a QQ chat')
      const path = String(args?.path ?? '')
      if (!path) throw new Error('path must not be empty')
      const agent = exec.agent
      const cwd = agent?.session?.header?.cwd
      const allowed = (cwd && isWithinRoot(path, cwd)) || isWithinRoot(path, MEDIA_ROOT)
      if (!allowed) throw new Error('path is outside the session working directory and the QQ media directory')
      const b = await botInstance()
      if (!b) throw new Error('QQ bot is not configured')
      const result = await sendMediaFile(b, passive(att.target), path)
      if (result.outcome === 'missing') {
        logLine(att.sessionId, 'out', 'qq_send_file', `missing: ${path}`)
        throw new Error('file does not exist')
      }
      if (result.outcome === 'failed') {
        logLine(att.sessionId, 'out', 'qq_send_file', `failed: ${path} — ${result.error}`)
        throw new Error(result.error)
      }
      logLine(att.sessionId, 'out', 'qq_send_file', `${path} (${result.size} B)`)
      return { sent: true, target: att.target, file: path }
    },
  }

  function syncPrompt(agent, runtime) {
    const att = bySession.get(agent.id)
    const want = att !== undefined && att.autoReply === false
    if (runtime.prompt && !want) { runtime.prompt(); runtime.prompt = undefined }
    if (want && !runtime.prompt) {
      runtime.prompt = agent.ctx.systemPrompt.section({
        name: 'qq_attach', order: 90, text: () => promptFor(agent.id),
      })
    }
  }

  /**
   * QQ tools exist only while automatic replies are off. When replies are forwarded
   * automatically the files travel through `present`, so exposing qq_send and
   * qq_send_file as well would give the agent two ways to reach the same chat.
   */
  function syncTools(agent, runtime) {
    const att = bySession.get(agent.id)
    const want = att !== undefined && att.autoReply === false
    const had = runtime.tools !== undefined
    if (want && !had) {
      runtime.tools = [
        agent.ctx.tools.register(qqSend),
        agent.ctx.tools.register(qqSendFile),
      ]
      logLine(agent.id, 'sys', 'tools', 'qq_send and qq_send_file enabled')
    } else if (!want && had) {
      for (const dispose of runtime.tools) { try { dispose() } catch {} }
      runtime.tools = undefined
      logLine(agent.id, 'sys', 'tools', 'qq_send and qq_send_file disabled')
    }
  }

  function ensureRuntime(agent) {
    let runtime = runtimes.get(agent.id)
    if (!runtime) {
      runtime = {}
      runtimes.set(agent.id, runtime)
    }
    syncTools(agent, runtime)
    syncPrompt(agent, runtime)
    return runtime
  }

  function disposeRuntime(sessionId) {
    const runtime = runtimes.get(sessionId)
    if (!runtime) return
    runtimes.delete(sessionId)
    try { runtime.prompt?.() } catch {}
    if (runtime.tools !== undefined) for (const dispose of runtime.tools) { try { dispose() } catch {} }
  }

  async function ensureAgent(sessionId) {
    const result = await ctx.sessionController.resolveAgent(sessionId)
    if (!result.agent) {
      log.warn(`qq-attach: cannot resume session ${sessionId}: ${result.error?.message ?? 'unknown'}`)
      return undefined
    }
    ensureRuntime(result.agent)
    return result.agent
  }

  // ---- inbound -----------------------------------------------------------

  async function onInbound(messageCtx, msg) {
    try {
      if (msg.kind !== 'c2c' && msg.kind !== 'group') return
      if (msg.senderIsBot) return
      // Learn names before any gating: a skipped message may be the only place a
      // member's nickname appears.
      learnMentions(msg)
      if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        attachmentNotes.set(msg.messageId, msg.attachments)
        while (attachmentNotes.size > ATTACHMENT_NOTE_LIMIT) {
          const oldest = attachmentNotes.keys().next().value
          attachmentNotes.delete(oldest)
        }
      }
      const target = targetOf(msg)
      if (!target) return
      const att = attaches.get(target)
      if (!att) { await rememberChat(target, msg.kind); return }

      // The SDK gate already covers the event type, the structured mention list and
      // the content fallback; the inline check stays only as a safety net.
      const decision = messageCtx?.state?.mention
      const mentioned = decision !== undefined
        ? decision.shouldAnswer
        : msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
          || msg.mentions?.some(mention => mention?.is_you === true)

      const attachments = Array.isArray(msg.attachments) ? msg.attachments : []
      const detail = {
        event: msg.rawEventType ?? 'unknown',
        sender: msg.senderName || msg.senderId,
        raw: String(msg.content ?? '').slice(0, 300),
        addressed: mentioned,
        reason: decision?.reason,
        mentions: Array.isArray(msg.mentions)
          ? msg.mentions.map(mention => ({
              is_you: mention?.is_you,
              scope: mention?.scope,
              nickname: mention?.nickname,
            }))
          : null,
        attachments: attachments.map(item => ({
          type: item?.content_type,
          name: item?.filename,
          size: item?.size,
        })),
        elements: Array.isArray(msg.msgElements) ? msg.msgElements.length : 0,
      }

      if (msg.kind === 'group' && !mentioned) {
        const shown = renderMentions(msg.content ?? '', resolveMention)
        const placeholder = attachments.map(attachmentLabel).join(' ')
        logLine(att.sessionId, 'in', 'skipped',
          `${detail.reason ?? 'not addressed'}: ${brief(shown ? `${shown} ${placeholder}`.trim() : placeholder) || '(no text)'}`, detail)
        return
      }

      const text = renderMentions(msg.content ?? '', resolveMention)
      if (!text && attachments.length === 0) return
      if (isArchived(att.sessionId)) {
        logLine(att.sessionId, 'in', 'error', 'session is archived; no turn can run, message dropped')
        return
      }
      lastMsg.set(target, { msgId: msg.messageId, at: Date.now(), count: 0 })
      const agent = await ensureAgent(att.sessionId)
      if (!agent) {
        logLine(att.sessionId, 'in', 'error', 'session is not available', detail)
        return
      }
      const context = await contextPrefix(messageCtx, msg, att.sessionId)
      const prefix = context.text
      logLine(att.sessionId, 'in', 'message', brief(text) || '(attachment only)', {
        ...detail,
        context: {
          quote: Boolean(messageCtx?.state?.quote),
          history: (messageCtx?.state?.history ?? []).length,
          quotedAttachments: context.blocks.length,
        },
      })
      const content = await buildContent(prefix ? `${prefix}\n\n${text}` : text, attachments, att.sessionId)
      if (context.blocks.length > 0) content.splice(Math.min(1, content.length), 0, ...context.blocks)
      if (content.length === 0) return
      const message = createUserMessage({ content, source: { kind: 'user' } })
      if (att.steer) agent.steer(message)
      else agent.followup(message)
      try { await ctx.sessions.flush?.(agent.session) } catch {}
    } catch (error) {
      logLine(attaches.get(targetOf(msg))?.sessionId, 'in', 'error',
        String(error instanceof Error ? error.message : error).slice(0, 300))
      log.warn(`qq-attach: inbound failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Context the QQ platform attaches to one inbound message: the quoted message
   * when the sender replied to something, plus buffered group chatter. Only the
   * platform-pushed events are available; QQ exposes no history API.
   */
  /** Download the attachments of the quoted message into content blocks. */
  async function ingestQuoted(descriptors, sessionId) {
    const blocks = []
    for (const item of descriptors) {
      const url = item?.url
      const name = item?.filename || item?.name || 'file'
      const contentType = item?.contentType ?? item?.content_type
      if (!url) continue
      try {
        const downloaded = await downloadAttachment(url, name, maxBytes)
        const mediaType = mediaTypeOf(contentType, name)
        if (mediaType && typeof ctx.attachments?.saveImage === 'function') {
          const ref = await ctx.attachments.saveImage({ data: downloaded.data, mediaType, name: downloaded.name })
          blocks.push({ type: 'image', attachment: ref })
          logLine(sessionId, 'in', 'quote-attachment', `${name} → image (${downloaded.data.byteLength} B)`)
        } else if (typeof ctx.attachments?.saveFile === 'function') {
          const ref = await ctx.attachments.saveFile({ data: downloaded.data, name: downloaded.name })
          blocks.push({ type: 'file', attachment: ref })
          logLine(sessionId, 'in', 'quote-attachment', `${name} → file (${downloaded.data.byteLength} B)`)
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logLine(sessionId, 'in', 'quote-attachment', `${name} → failed: ${reason}`)
        blocks.push({ type: 'text', text: `[quoted attachment unavailable: ${name}]` })
      }
    }
    return blocks
  }

  /**
   * Context attached to one addressed message: the quoted message (with its own
   * attachments), plus buffered group chatter as text only. Attachments of
   * messages that did not address the bot are never downloaded.
   */
  async function contextPrefix(messageCtx, msg, sessionId) {
    const state = messageCtx?.state ?? {}
    const parts = []
    const blocks = []

    const quote = state.quote
    const quoted = Array.isArray(quote?.attachments) && quote.attachments.length > 0
      ? quote.attachments
      : Array.isArray(quote?.entry?.attachments) ? quote.entry.attachments : []
    blocks.push(...await ingestQuoted(quoted, sessionId))

    let quoteText = brief(renderMentions(quote?.text ?? '', resolveMention), 300)
    if (!quoteText && quoted.length > 0) quoteText = quoted.map(attachmentLabel).join(' ')
    if (quoteText) {
      const who = quote?.entry?.senderName || quote?.entry?.senderId
      parts.push(`<reply_to>${who ? `${who}: ` : ''}${quoteText}</reply_to>`)
    }

    const history = Array.isArray(state.history) ? state.history : []
    if (historyLimit > 0 && history.length > 0) {
      const rows = []
      for (const entry of history.slice(-historyLimit)) {
        const raw = entry.content ?? ''
        // A message that addressed the bot is already its own turn in the session.
        const addressesBot = [...botMentionIds].some(id => raw.includes(`<@${id}>`) || raw.includes(`<@!${id}>`))
        if (addressesBot) continue
        const spoken = renderMentions(raw, resolveMention)
        // Attachments of skipped messages are placeholders only: never downloaded.
        const placeholder = noteFor(entry.messageId).map(attachmentLabel).join(' ')
        const content = brief(spoken ? `${spoken} ${placeholder}`.trim() : placeholder, 200)
        if (!content) continue
        rows.push(`${entry.senderName || entry.senderId || 'unknown'}: ${content}`)
      }
      if (rows.length > 0) parts.push(`<history>\n${rows.join('\n')}\n</history>`)
    }

    if (parts.length === 0 && blocks.length === 0) return { text: '', blocks: [] }
    const sender = msg.senderName || msg.senderId || 'unknown'
    const body = parts.join('\n')
    return {
      text: body ? `<qq_context>\nfrom: ${sender}\n${body}\n</qq_context>` : '',
      blocks,
    }
  }

  async function buildContent(text, attachments, sessionId) {
    const content = []
    if (text) content.push({ type: 'text', text })
    if (!mediaEnabled || attachments.length === 0) return content
    for (const item of attachments) {
      const name = item.filename || 'file'
      if (item.asr_refer_text) content.push({ type: 'text', text: `[voice] ${item.asr_refer_text}` })
      try {
        const downloaded = await downloadAttachment(item.url, name, maxBytes)
        const mediaType = mediaTypeOf(item.content_type, name)
        if (mediaType && typeof ctx.attachments?.saveImage === 'function') {
          const ref = await ctx.attachments.saveImage({ data: downloaded.data, mediaType, name: downloaded.name })
          content.push({ type: 'image', attachment: ref })
          logLine(sessionId, 'in', 'attachment', `${name} → image (${downloaded.data.byteLength} B, ${mediaType})`)
        } else if (typeof ctx.attachments?.saveFile === 'function') {
          const ref = await ctx.attachments.saveFile({ data: downloaded.data, name: downloaded.name })
          content.push({ type: 'file', attachment: ref })
          logLine(sessionId, 'in', 'attachment', `${name} → file (${downloaded.data.byteLength} B)`)
        } else {
          logLine(sessionId, 'in', 'attachment', `${name} → dropped (no attachment service)`)
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logLine(sessionId, 'in', 'attachment', `${name} → failed: ${reason}`)
        log.warn(`qq-attach: attachment skipped: ${reason}`)
      }
    }
    return content
  }

  // ---- outbound ----------------------------------------------------------

  function onStreamFrame(payload) {
    const agentId = payload?.agent?.id
    const frame = payload?.frame
    if (!agentId || !frame?.attemptId) return
    const att = bySession.get(agentId)
    if (!att || !att.autoReply || !att.streaming) return
    if (!att.target.startsWith('c2c:')) return
    const last = lastMsg.get(att.target)
    if (!last || Date.now() - last.at > C2C_TTL || last.count >= 4) return
    if (!bot) return
    if (frame.type === 'start') {
      cancelStream(att.target)
      streams.set(att.target, { text: '', session: undefined, attemptId: frame.attemptId })
      return
    }
    if (frame.type !== 'chunk' || frame.chunk?.type !== 'text-delta' || !frame.chunk.text) return
    let state = streams.get(att.target)
    if (!state) { state = { text: '', attemptId: frame.attemptId }; streams.set(att.target, state) }
    state.text += frame.chunk.text
    if (!state.session) {
      try {
        const parts = parseTarget(att.target)
        state.session = bot.openStream({ target: { ...parts, msgId: last.msgId } })
        logLine(att.sessionId, 'out', 'stream', 'started')
      } catch (error) {
        logLine(att.sessionId, 'out', 'stream', `open failed: ${error instanceof Error ? error.message : error}`)
        streams.delete(att.target)
        return
      }
    }
    void state.session.update(state.text).catch(() => cancelStream(att.target))
  }

  function cancelStream(target) {
    const state = streams.get(target)
    if (!state) return
    streams.delete(target)
    const owner = [...bySession.entries()].find(([, att]) => att.target === target)
    if (owner) logLine(owner[0], 'out', 'stream', 'cancelled')
    try { state.session?.cancel?.() } catch {}
  }

  function cancelAllStreams() {
    for (const target of [...streams.keys()]) cancelStream(target)
  }

  async function onAssistant(att, event) {
    const blocks = event.data?.message?.content
    const text = Array.isArray(blocks)
      ? blocks.filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n').trim()
      : ''
    const state = streams.get(att.target)
    if (state?.session) {
      streams.delete(att.target)
      try { await state.session.complete(); logLine(att.sessionId, 'out', 'stream', `${state.text.length} chars`) } catch (error) {
        logLine(att.sessionId, 'out', 'stream', `complete failed: ${error instanceof Error ? error.message : error}`)
      }
      return
    }
    streams.delete(att.target)
    if (!att.autoReply) return
    if (!text) return
    try {
      await sendText(att.target, text)
      logLine(att.sessionId, 'out', 'reply', text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logLine(att.sessionId, 'out', 'reply', `failed: ${reason}`)
      log.warn(`qq-attach: send failed: ${reason}`)
    }
  }

  /** Compact reason for a failed tool result: structured code, else its first text. */
  function failureDetail(data) {
    const code = data.error?.code
    if (typeof code === 'string' && code) return code
    const text = (Array.isArray(data.message?.content) ? data.message.content : [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text)
      .map(block => block.text)
      .join(' ')
      .replace(/^Error:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return 'ERROR'
    return text.length > 240 ? `${text.slice(0, 240)}…` : text
  }

  async function onSessionEvent(session, event) {
    const att = bySession.get(session.id)
    if (!att) return
    const data = event.data ?? {}
    if (event.type === 'tool/call' && data.callId && data.name) { toolNames.set(data.callId, data.name); return }
    if (event.type === 'tool/result') {
      const callId = data.message?.source?.callId
      const name = callId ? toolNames.get(callId) : undefined
      if (callId) toolNames.delete(callId)
      // An ordinary tool failure is flagged by `message.isError`; `data.error`
      // only carries aborts and structured failures. Checking `data.error`
      // alone silently disabled the `errors` switch for every tool throw.
      const failed = data.message?.isError === true || (data.error !== undefined && data.error !== null)
      if (att.errors && failed) {
        const line = `⚠️ tool ${name ?? 'call'} failed: ${failureDetail(data)}`
        try {
          await sendText(att.target, line)
          logLine(att.sessionId, 'out', 'tool-error', line)
        } catch (error) {
          logLine(att.sessionId, 'out', 'tool-error', `send failed: ${error instanceof Error ? error.message : error}`)
        }
      } else if (att.toolResults) {
        const line = `🔧 ${name ?? 'tool'} finished`
        try {
          await sendText(att.target, line)
          logLine(att.sessionId, 'out', 'tool-result', line)
        } catch (error) {
          logLine(att.sessionId, 'out', 'tool-result', `send failed: ${error instanceof Error ? error.message : error}`)
        }
      }
      return
    }
    if (event.type === 'assistant/message') { await onAssistant(att, event); return }
    if (event.type === 'deliverables/presented') {
      const files = Array.isArray(data.files) ? data.files : []
      const list = presented.get(session.id) ?? []
      for (const file of files) if (typeof file?.path === 'string') list.push(file.path)
      presented.set(session.id, list)
      return
    }
    if (event.type === 'turn/end') {
      const files = presented.get(session.id) ?? []
      presented.delete(session.id)
      const reason = data.reason ?? {}
      if (att.autoReply && files.length > 0) {
        const b = await botInstance().catch(() => undefined)
        if (b) {
          for (const path of files.slice(0, maxFiles)) {
            const result = await sendMediaFile(b, passive(att.target), path)
            if (result.outcome === 'failed') {
              logLine(att.sessionId, 'out', 'deliverable', `${path} → failed: ${result.error}`)
              try { await sendText(att.target, `⚠️ file send failed: ${path}`) } catch {}
            } else {
              logLine(att.sessionId, 'out', 'deliverable', `${path} (${result.size} B)`)
            }
          }
          if (files.length > maxFiles) logLine(att.sessionId, 'out', 'deliverable', `${files.length - maxFiles} file(s) over the limit not sent`)
        }
      }
      if (att.errors && reason.kind === 'error') {
        const line = `⚠️ turn failed: ${reason.error?.code ?? 'ERROR'}`
        try {
          await sendText(att.target, line)
          logLine(att.sessionId, 'out', 'turn-error', line)
        } catch (error) {
          logLine(att.sessionId, 'out', 'turn-error', `send failed: ${error instanceof Error ? error.message : error}`)
        }
      }
      return
    }
  }

  ctx.on('session/event', (session, event) => { void onSessionEvent(session, event) })
  ctx.on('agent/assistant-stream', payload => onStreamFrame(payload), { global: true })
  ctx.on('agent/disposed', ({ agent }) => { disposeRuntime(agent.id) })
  ctx.on('agent/created', ({ agent }) => {
    const att = bySession.get(agent.id)
    if (att) ensureRuntime(agent)
  })

  // ---- binding -----------------------------------------------------------

  async function qrSvg(url) {
    qrLib ??= requireQr('qrcode')
    const svg = await qrLib.toString(url, { type: 'svg', margin: 1, width: 240 })
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  }

  async function applyCredentials(appId, appSecret) {
    if (!appId || !appSecret) throw new Error('AppID and AppSecret are required')
    await ctx.credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'api-key', key: appSecret }))
    await account.put('main', { appId, updatedAt: Date.now() })
    await restartBot()
  }

  function startBind() {
    if (bindState.phase === 'waiting' || bindState.phase === 'starting') return bindState
    stopBind?.()
    bindState = { phase: 'starting' }
    stopBind = startQrConnect({
      onQrDisplayed: (url) => {
        bindState = { phase: 'waiting', url }
        void qrSvg(url).then((svg) => {
          if (bindState.phase === 'waiting' && bindState.url === url) bindState = { phase: 'waiting', url, qrSvg: svg }
        }).catch(() => {})
      },
      onQrExpired: () => { bindState = { phase: 'failed', reason: 'QR code expired' } },
      onSuccess: (credentials) => {
        const credential = credentials?.[0]
        if (!credential) { bindState = { phase: 'failed', reason: 'the scan returned no credentials' }; return }
        bindState = { phase: 'saving' }
        void applyCredentials(credential.appId, credential.appSecret)
          .then(() => { bindState = { phase: 'done' } })
          .catch((error) => { bindState = { phase: 'failed', reason: error instanceof Error ? error.message : String(error) } })
      },
      onFailure: (error) => {
        bindState = { phase: 'failed', reason: error instanceof Error ? error.message : String(error) }
      },
    }, { source: 'dsh-qq-attach' })
    return bindState
  }

  // ---- RPC ---------------------------------------------------------------

  const attachOf = (sessionId) => {
    const att = bySession.get(sessionId)
    if (!att) return null
    const { sessionId: _id, target, ...settings } = att
    return { target, ...settings, defaultPrompt: DEFAULT_PROMPT }
  }

  async function listAttaches() {
    const rows = []
    for (const [target, value] of attaches.entries()) {
      let title
      try { title = await ctx.sessionQuery.readTitle(value.sessionId) } catch {}
      rows.push({ target, ...value, title, archived: isArchived(value.sessionId) })
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }

  async function route(endpoint, payload) {
    switch (endpoint) {
      case 'status': {
        const saved = account.get('main')
        const hasSecret = Boolean(await readSecret())
        return { build: BUILD, bound: Boolean(saved?.appId), appId: saved?.appId, running: Boolean(bot), hasSecret, error: botError ?? null, link: { ...link } }
      }
      case 'bind.start': return startBind()
      case 'bind.state': return bindState
      case 'bind.cancel': stopBind?.(); stopBind = undefined; bindState = { phase: 'idle' }; return bindState
      case 'account.set': {
        await applyCredentials(String(payload.appId ?? ''), String(payload.appSecret ?? ''))
        logAll('sys', 'account', `credentials set for ${String(payload.appId ?? '')}`)
        return { bound: true, appId: payload.appId }
      }
      case 'account.clear': {
        stopBind?.(); stopBind = undefined
        await account.delete('main')
        await ctx.credentials.deleteRecord(CREDENTIAL_KEY)
        await restartBot()
        bindState = { phase: 'idle' }
        logAll('sys', 'account', 'credentials cleared')
        return { bound: false }
      }
      case 'chats.list': {
        const rows = [...chats.entries()]
          .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
          .map(([target, value]) => {
            const holder = attaches.get(target)?.sessionId ?? null
            return { target, kind: value.kind, lastSeen: value.lastSeen, attachedTo: holder, archived: holder === null ? false : isArchived(holder) }
          })
        return rows
      }
      case 'attach.get': return attachOf(String(payload.sessionId ?? ''))
      case 'attach.list': return listAttaches()
      case 'log.list': return logs.get(String(payload.sessionId ?? '')) ?? []
      case 'log.clear': {
        logs.delete(String(payload.sessionId ?? ''))
        return { cleared: true }
      }
      case 'attach.set': {
        const sessionId = String(payload.sessionId ?? '')
        const target = String(payload.target ?? '')
        if (!sessionId || !parseTarget(target)) throw new Error('invalid session or target')
        const resolved = await ctx.sessionController.resolveAgent(sessionId)
        if (!resolved.agent) throw new Error(resolved.error?.message ?? 'session is not available')
        if (resolved.agent.session.header.origin === 'subagent') throw new Error('subagent sessions cannot attach')
        const current = bySession.get(sessionId)
        if (current && current.target !== target) throw new Error('detach the current chat first')
        const holder = attaches.get(target)
        if (holder && holder.sessionId !== sessionId) {
          if (payload.steal !== true) throw new Error('this chat is attached to another session')
          // Takeover is explicit: the previous session loses the chat and its tools.
          await attaches.delete(target)
          cancelStream(target)
          disposeRuntime(holder.sessionId)
          logLine(holder.sessionId, 'sys', 'attach', `detached: the chat was claimed by ${sessionId}`)
        }
        const record = {
          sessionId,
          autoReply: current?.autoReply ?? true,
          streaming: current?.streaming ?? true,
          toolResults: current?.toolResults ?? false,
          errors: current?.errors ?? true,
          steer: current?.steer ?? true,
          prompt: current?.prompt ?? '',
          createdAt: current?.createdAt ?? Date.now(),
        }
        if (current) await attaches.delete(current.target)
        await attaches.put(target, record)
        rebuild()
        await rememberChat(target, target.startsWith('group:') ? 'group' : 'c2c')
        ensureRuntime(resolved.agent)
        logLine(sessionId, 'sys', 'attach', `attached to ${target}`)
        return attachOf(sessionId)
      }
      case 'attach.update': {
        const sessionId = String(payload.sessionId ?? '')
        const att = bySession.get(sessionId)
        if (!att) throw new Error('this session is not attached')
        const patch = payload.patch ?? {}
        const next = { ...att, target: undefined, sessionId: undefined }
        for (const key of ['autoReply', 'streaming', 'toolResults', 'errors', 'steer']) {
          if (typeof patch[key] === 'boolean') next[key] = patch[key]
        }
        if (typeof patch.prompt === 'string') next.prompt = patch.prompt.trim()
        const record = {
          sessionId,
          autoReply: next.autoReply,
          streaming: next.streaming,
          toolResults: next.toolResults,
          errors: next.errors,
          steer: next.steer,
          prompt: next.prompt ?? '',
          createdAt: att.createdAt,
        }
        await attaches.put(att.target, record)
        rebuild()
        const live = ctx.agents.get(sessionId)
        if (live) ensureRuntime(live)
        return attachOf(sessionId)
      }
      case 'attach.remove': {
        const sessionId = String(payload.sessionId ?? '')
        const att = bySession.get(sessionId)
        if (!att) return { removed: false }
        await attaches.delete(att.target)
        disposeRuntime(sessionId)
        rebuild()
        logLine(sessionId, 'sys', 'attach', `detached from ${att.target}`)
        return { removed: true }
      }
      default: throw new Error(`unknown endpoint: ${endpoint}`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/qq-attach',
    handler: async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const endpoint = pathname.startsWith('/qq-attach/') ? pathname.slice('/qq-attach/'.length) : ''
      let payload = {}
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const text = Buffer.concat(chunks).toString('utf8')
        payload = text ? JSON.parse(text) : {}
      } catch {}
      try {
        const value = await route(endpoint, payload)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value }))
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'qq-attach', message: error instanceof Error ? error.message : String(error) } }))
      }
    },
  }), 'qq-attach: route')

  // ---- media cleanup and startup ----------------------------------------

  if (ttlHours > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void (async () => {
          try {
            await mkdir(MEDIA_ROOT, { recursive: true })
            const cutoff = Date.now() - ttlHours * 3600 * 1000
            for (const name of await readdir(MEDIA_ROOT)) {
              const path = `${MEDIA_ROOT}/${name}`
              try { const info = await stat(path); if (info.isFile() && info.mtimeMs < cutoff) await unlink(path) } catch {}
            }
          } catch {}
        })()
      }, 3600 * 1000)
      return () => clearInterval(timer)
    }, 'qq-attach: media cleanup')
  }

  ctx.effect(() => () => {
    for (const sessionId of [...runtimes.keys()]) disposeRuntime(sessionId)
    stopBind?.()
    cancelAllStreams()
    void bot?.stop()
  }, 'qq-attach: stop bot')

  for (const att of bySession.values()) {
    const live = ctx.agents.get(att.sessionId)
    if (live) ensureRuntime(live)
  }
  if (account.get('main')?.appId) void botInstance().catch(() => {})
}

