/**
 * The bottom-right update reminder: one floating panel, rendered only while a
 * newer release exists and has not been dismissed. Each in-range release
 * shows as a collapsed title row (our release titles are written as bilingual
 * user-facing summaries, so the row doubles as the highlight line); opening
 * one reveals its notes under the markdown whitelist below.
 */

import { useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { WORKBUDDY_REPOSITORY_URL } from '../update.ts'
import type { WorkBuddyUpdateRelease } from '../update.ts'
import { WorkBuddyUpdateStore } from './update-store.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Props the reminder renders from; Partial so the slot typing accepts it. */
export type WorkBuddyUpdateNoticeProps = Partial<{
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  updater: WorkBuddyUpdateStore
}>
const DEFAULT_T: NonNullable<WorkBuddyUpdateNoticeProps['t']> = (key, _params) => String(key)

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '13px 15px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-primary)',
}
const overlayStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
  right: 20,
  zIndex: 30,
  width: 'min(440px, calc(100vw - 40px))',
  // The shell.overlay seat is click-through by contract; an entry must opt
  // back into pointer events or none of its buttons work.
  pointerEvents: 'auto',
  // The panel is bottom-anchored and the release list can be long: cap it at
  // the viewport and let the whole panel scroll rather than grow past the top.
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  boxSizing: 'border-box',
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.16)',
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }
const titleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const bodyStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px' }
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const releaseRowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 9px', borderRadius: 7, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))', border: 0, width: '100%', boxSizing: 'border-box', color: 'inherit', font: 'inherit', fontSize: 13, lineHeight: '19px', textAlign: 'left', cursor: 'pointer', overflowWrap: 'anywhere' }
const buttonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', minHeight: 32, padding: '4px 11px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '20px', whiteSpace: 'nowrap', cursor: 'pointer' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, borderColor: 'var(--dsw-alias-button-primary-fill)', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }
const textButtonStyle: CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'var(--dsw-alias-brand-primary)', font: 'inherit', fontSize: 12, lineHeight: '20px', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }
const promptRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px 7px 10px', borderRadius: 7, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))' }
const promptTextStyle: CSSProperties = { flex: '1 1 auto', minWidth: 0, margin: 0, padding: 0, background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
const notesStyle: CSSProperties = { maxHeight: 220, overflowY: 'auto', margin: '4px 0 0', padding: '9px 10px', borderRadius: 7, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '19px', overflowWrap: 'anywhere' }
const notesListStyle: CSSProperties = { margin: '4px 0', paddingLeft: 18 }
const notesHeadingStyle: CSSProperties = { margin: '0 0 4px', fontSize: 12, lineHeight: '19px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

async function copyAgentPrompt(prompt: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText === undefined) return false
    await navigator.clipboard.writeText(prompt)
    return true
  } catch {
    return false
  }
}

/** Only same-origin GitHub links may render as anchors; everything else is text. */
function safeReleaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : undefined
  } catch {
    return undefined
  }
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const tokens = /(?:\*\*[^*]+\*\*|\[[^\]]+\]\(https:\/\/[^)\s]+\)|https:\/\/[^\s<]+)/gu
  const children: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let tokenIndex = 0
  while ((match = tokens.exec(text)) !== null) {
    if (match.index > lastIndex) children.push(text.slice(lastIndex, match.index))
    const token = match[0]
    const bold = /^\*\*([^*]+)\*\*$/u.exec(token)
    const markdownLink = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/u.exec(token)
    const bareUrl = /^https:\/\/[^\s<]+$/u.test(token) ? token.replace(/[.,]$/u, '') : undefined
    if (bold !== null) {
      children.push(<strong key={`${keyPrefix}-bold-${tokenIndex}`}>{bold[1] ?? ''}</strong>)
    } else if (markdownLink !== null) {
      const label = markdownLink[1] ?? token
      const href = markdownLink[2] === undefined ? undefined : safeReleaseUrl(markdownLink[2])
      children.push(href === undefined ? label : <a key={`${keyPrefix}-link-${tokenIndex}`} href={href} target="_blank" rel="noopener noreferrer">{label}</a>)
    } else if (bareUrl !== undefined) {
      const href = safeReleaseUrl(bareUrl)
      children.push(href === undefined ? token : <a key={`${keyPrefix}-url-${tokenIndex}`} href={href} target="_blank" rel="noopener noreferrer">{token}</a>)
    } else {
      children.push(token)
    }
    lastIndex = match.index + token.length
    tokenIndex += 1
  }
  if (lastIndex < text.length) children.push(text.slice(lastIndex))
  return children
}

function renderReleaseNotes(markdown: string): ReactNode {
  const content: ReactNode[] = []
  let bullets: ReactNode[] = []
  const flushBullets = () => {
    if (bullets.length === 0) return
    content.push(<ul key={`list-${content.length}`} style={notesListStyle}>{bullets}</ul>)
    bullets = []
  }
  markdown.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    const bullet = /^[-*]\s+(.+)$/u.exec(trimmed)
    const heading = /^#{1,6}\s+(.+)$/u.exec(trimmed)
    if (bullet !== null) {
      bullets.push(<li key={`item-${index}`}>{renderInlineMarkdown(bullet[1] ?? '', `item-${index}`)}</li>)
    } else if (heading !== null) {
      flushBullets()
      content.push(<h4 key={`heading-${index}`} style={notesHeadingStyle}>{renderInlineMarkdown(heading[1] ?? '', `heading-${index}`)}</h4>)
    } else if (trimmed !== '') {
      flushBullets()
      content.push(<p key={`paragraph-${index}`} style={{ ...bodyStyle, fontSize: 12, lineHeight: '19px' }}>{renderInlineMarkdown(trimmed, `paragraph-${index}`)}</p>)
    } else {
      flushBullets()
    }
  })
  flushBullets()
  return <div style={notesStyle}>{content}</div>
}

/** One in-range release: a collapsed title row that opens its notes. */
function ReleaseRow({ release, t }: { release: WorkBuddyUpdateRelease, t: NonNullable<WorkBuddyUpdateNoticeProps['t']> }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" style={releaseRowStyle} aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>{release.name ?? `v${release.version}`}</span>
      </button>
      {open
        ? release.notes === undefined
          ? <p style={{ ...bodyStyle, fontSize: 12, padding: '4px 9px 0', margin: 0 }}>{t('releaseNotesUnavailable')}</p>
          : renderReleaseNotes(release.notes)
        : null}
    </div>
  )
}

/** Bottom-right reminder registered in the shell.overlay list seat. */
export function WorkBuddyUpdateOverlay({ t = DEFAULT_T, updater }: WorkBuddyUpdateNoticeProps) {
  if (updater === undefined) return null
  const snapshot = useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot)
  const latestVersion = snapshot.latestVersion
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [recheckRequested, setRecheckRequested] = useState(false)

  const noticeKey = latestVersion === undefined ? undefined : `${snapshot.currentVersion}:${latestVersion}`
  const pendingRecheck = recheckRequested && (snapshot.status === 'checking' || snapshot.status === 'unavailable')
  // The floating seat stays invisible unless there is something to say: no
  // new version, a dismissed pair, or a transient failure all render nothing.
  // A pending recheck keeps the panel so it does not vanish mid-interaction.
  if (!pendingRecheck && (snapshot.status !== 'update-available' || noticeKey === undefined || snapshot.dismissedNotice === noticeKey)) return null
  const available = snapshot.status === 'update-available'
  const releases = snapshot.releases ?? []
  const agentPrompt = t('agentUpgradePrompt', { repository: WORKBUDDY_REPOSITORY_URL })
  const copy = async (): Promise<void> => {
    setCopyFailed(false)
    const ok = await copyAgentPrompt(agentPrompt)
    setCopied(ok)
    setCopyFailed(!ok)
  }

  return (
    <div style={{ ...panelStyle, ...overlayStyle }} role="status" aria-label={t('updateNoticeLabel')}>
      <div style={rowStyle}>
        <strong style={titleStyle}>{available ? t('newVersionAvailable', { version: latestVersion }) : t('updateNoticeLabel')}</strong>
        <button type="button" style={buttonStyle} aria-label={t('dismissUpdate')} onClick={() => { setRecheckRequested(false); if (noticeKey !== undefined) updater.dismiss(noticeKey) }}>
          {t('dismissUpdate')}
        </button>
      </div>
      {available
        ? <>
          <p style={bodyStyle}>
            {t('versionSummary', { current: snapshot.currentVersion, latest: latestVersion })}
            {snapshot.versionsBehind === undefined ? ` · ${t('versionsBehindUnknown')}` : ` · ${t('versionsBehind', { count: snapshot.versionsBehind })}`}
          </p>
          <div style={sectionStyle}>
            <strong style={titleStyle}>{t('releasesHeading')}</strong>
            {releases.length === 0
              ? <p style={bodyStyle}>{t('releaseListUnavailable')}</p>
              : releases.map(release => <ReleaseRow key={release.version} release={release} t={t} />)}
          </div>
        </>
        : <p style={bodyStyle}>{t('updateCheckUnavailable')}</p>}
      <div style={sectionStyle}>
        <div style={promptRowStyle}>
          <code style={promptTextStyle}>{agentPrompt}</code>
          <button type="button" style={buttonStyle} onClick={() => { void copy() }}>
            {copied ? t('agentPromptCopied') : t('copyForAgent')}
          </button>
        </div>
        {copyFailed ? <p style={{ ...bodyStyle, fontSize: 12, margin: 0 }}>{t('agentPromptCopyFailed')}</p> : null}
        <div style={rowStyle}>
          <button type="button" style={primaryButtonStyle} disabled={!available} onClick={() => { setRecheckRequested(true); void updater.refresh(true) }}>
            {snapshot.status === 'checking' ? t('checkingForUpdates') : t('recheckAfterUpgrade')}
          </button>
          {snapshot.releaseUrl === undefined ? null : (
            <a href={snapshot.releaseUrl} target="_blank" rel="noopener noreferrer" style={textButtonStyle}>
              {t('openReleasePage')}
            </a>
          )}
        </div>
        {recheckRequested && snapshot.status === 'update-available' ? <p style={{ ...bodyStyle, fontSize: 12, margin: 0 }}>{t('upgradeStillAvailable', { version: snapshot.currentVersion })}</p> : null}
      </div>
    </div>
  )
}
