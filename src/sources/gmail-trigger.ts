/** Gmail message schema, plain-text extraction and translation of one message into a Trigger. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const SOURCE = 'gmail'
/** Longest message text a Trigger carries; the worker reads the rest from Gmail itself. */
const TEXT_LIMIT = 20_000
export interface Part { mimeType?: string | undefined; body?: { data?: string | undefined } | undefined; parts?: Part[] | undefined }
const PartSchema: z.ZodType<Part> = z.lazy(() => z.looseObject({
  mimeType: z.string().optional(), body: z.looseObject({ data: z.string().optional() }).optional(), parts: z.array(PartSchema).optional() }))
/** One message as Gmail's `users.messages.get` with `format=full` (and each entry of `users.threads.get`) prints it. */
export const MessageSchema = z.looseObject({
  id: z.string().min(1), threadId: z.string().min(1), internalDate: z.string().regex(/^\d+$/), labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(''),
  payload: z.looseObject({ headers: z.array(z.looseObject({ name: z.string(), value: z.string() })).default([]) }).extend({
    mimeType: z.string().optional(), body: z.looseObject({ data: z.string().optional() }).optional(), parts: z.array(PartSchema).optional() }),
})
export type GmailMessage = z.infer<typeof MessageSchema>
export const ListSchema = z.looseObject({ messages: z.array(z.looseObject({ id: z.string(), threadId: z.string() })).default([]) })
export const ThreadSchema = z.looseObject({ messages: z.array(z.unknown()).default([]) })

/** A header's value, matched case-insensitively. */
export const header = (message: GmailMessage, name: string): string =>
  message.payload.headers.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? ''
/** The bare address of a `Name <address>` header, lower-cased. */
export const addressOf = (value: string): string => (/<([^<>\s]+)>/.exec(value)?.[1] ?? value.split(',')[0] ?? '').trim().toLowerCase()
const decode = (data: string): string => Buffer.from(data, 'base64url').toString('utf8')
const plain = (part: Part): string | undefined => {
  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data)
  for (const child of part.parts ?? []) { const found = plain(child); if (found !== undefined) return found }
  return undefined
}
/** The message's plain text, or Gmail's snippet when it has no plain part. */
export const bodyOf = (message: GmailMessage): string => plain(message.payload) ?? message.snippet
export const gmailTriggerId = (messageId: string): string => key(SOURCE, messageId)

/**
 * Whether the receiving server vouches for the sender. `From:` is written by the sender, so the allowed list may trust it only
 * when Gmail's `Authentication-Results` records a passing DKIM or SPF check. A message with no such header, such as one the
 * mailbox itself wrote, is trusted; one whose checks failed or are all absent is not.
 */
export function authenticated(message: GmailMessage): boolean {
  const results = header(message, 'Authentication-Results')
  return !results || /\b(dkim|spf)=pass\b/i.test(results)
}

/** The Trigger of one message; a draft, which the agent itself wrote, produces none. */
export function gmailTrigger(message: GmailMessage): Trigger | undefined {
  if (message.labelIds.includes('DRAFT')) return undefined
  const from = header(message, 'From')
  const subject = header(message, 'Subject')
  const reply = addressOf(header(message, 'Reply-To') || from)
  return {
    id: gmailTriggerId(message.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: message.threadId }],
    // A sender the server did not vouch for has no identity here, so it cannot be on the allowed list.
    actor: { source: SOURCE, id: authenticated(message) ? addressOf(from) : '' },
    // Mail the Source receives was labelled or forwarded to the agent on purpose; automated senders are filtered by the allowed list.
    human: !/^(no-?reply|mailer-daemon|postmaster)\b/i.test(addressOf(from)),
    addressed: 'direct',
    at: new Date(Number(message.internalDate)).toISOString(),
    text: `Subject: ${subject}\n\n${bodyOf(message)}`.slice(0, TEXT_LIMIT),
    channel: { source: SOURCE, thread: `${SOURCE}:${message.threadId}`,
      address: { threadId: message.threadId, messageId: message.id, to: reply, subject, rfcId: header(message, 'Message-ID'),
        url: `https://mail.google.com/mail/u/0/#all/${message.threadId}` } },
    url: `https://mail.google.com/mail/u/0/#all/${message.threadId}`,
    meta: { mailbox: true, messageId: message.id, threadId: message.threadId, subject },
  }
}
