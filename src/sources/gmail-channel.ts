/** Gmail Channel: a reply becomes a draft in the message's thread; the agent never sends mail. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import type { ChannelLink } from './kind.ts'
import type { SourceContext } from './host.ts'

/** Runs the Gmail CLI as `<cli> gmail users <resource> <method>` with Gmail's own parameters; the one place that knows the CLI's syntax. */
export const GMAIL_CLI = 'gws'
export function gmail(commands: Commands, resource: string, method: string, params: Record<string, unknown>, body?: unknown): Promise<string> {
  return commands.run(GMAIL_CLI, ['gmail', 'users', resource, method, '--params', JSON.stringify({ userId: 'me', ...params }),
    ...body === undefined ? [] : ['--json', JSON.stringify(body)]])
}
/** A header value with line breaks removed, so text from a message cannot add headers to the draft. */
const line = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim()
/** The raw RFC 822 draft, base64url encoded, ending with the marker that makes a retried send find the draft it made. */
export function rawDraft(message: OutboundMessage): string {
  const { to = '', subject = '', rfcId = '' } = message.channel.address
  const reference = rfcId ? [`In-Reply-To: ${line(rfcId)}`, `References: ${line(rfcId)}`] : []
  const title = /^re:/i.test(subject) ? subject : `Re: ${subject}`
  const mime = [`To: ${line(to)}`, `Subject: ${line(title)}`, ...reference, 'Content-Type: text/plain; charset=utf-8', '',
    message.text, '', marker(message.id)].join('\r\n')
  return Buffer.from(mime, 'utf8').toString('base64url')
}
const marker = (id: string): string => `[dsh-superagent:${id}]`
const DraftsSchema = z.looseObject({ drafts: z.array(z.unknown()).default([]) })

/** Creates the draft once per message id: Gmail's search finds a draft carrying the marker of an earlier try. */
export async function sendGmail(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { threadId } = message.channel.address
  if (!threadId) throw new Error('Missing Gmail reply target')
  try {
    const found = DraftsSchema.parse(JSON.parse(await gmail(host.commands, 'drafts', 'list', { q: `"${marker(message.id)}"` })))
    if (found.drafts.length) return 'sent'
    await gmail(host.commands, 'drafts', 'create', {}, { message: { threadId, raw: rawDraft(message) } })
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 404) return 'gone'
    throw error
  }
}
export function gmailLink(address: Record<string, string>): ChannelLink {
  return { url: address.url ?? '', label: { zh: `Gmail 会话 ${address.subject ?? ''}`, en: `Gmail conversation ${address.subject ?? ''}` } }
}
