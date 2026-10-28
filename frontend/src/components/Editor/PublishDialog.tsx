/**
 * Episode details for a DarkRelay bundle: show, title, notes, release time,
 * numbering, chapters, cover art and YouTube copy.
 *
 * Chapters are stored in source time so they follow later edits, but entered
 * and shown in edited time, which is what listeners hear.
 */
import { useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { EpisodeType, Project, PublishChapter, PublishDetailsInput } from '../../api/types'
import { outputToSourceTime, sourceToOutputTime, type TimeRange } from '../Timeline/timeMap'

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const YT_TITLE_MAX = 100
const YT_DESCRIPTION_MAX_BYTES = 5000

function editable(project: Project): PublishDetailsInput {
  const { guid: _guid, cover: _cover, bundle: _bundle, ...rest } = project.publish
  return rest
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "1:02:03", "2:03" or "45" → seconds; null if it isn't a time. */
function parseTime(text: string): number | null {
  const parts = text.trim().split(':')
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}

/** ISO with offset → the value a datetime-local input shows (local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const label = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)', minWidth: 0 } as const
const input = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', padding: '6px 8px', fontSize: 13, fontFamily: 'inherit',
  width: '100%', boxSizing: 'border-box',
} as const
const smallButton = {
  background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
  borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
} as const

export default function PublishDialog({
  project,
  keptRanges,
  currentTime,
  onChange,
  onClose,
}: {
  project: Project
  keptRanges: TimeRange[]
  /** Editor playhead, in source time */
  currentTime: number
  onChange: (p: Project) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<PublishDetailsInput>(() => editable(project))
  // Chapter times as typed (edited time); parsed on save
  const [chapterTimes, setChapterTimes] = useState<string[]>(() =>
    project.publish.chapters.map((c) => formatTime(sourceToOutputTime(c.start, keptRanges))),
  )
  const [keywords, setKeywords] = useState(project.publish.keywords.join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coverBusy, setCoverBusy] = useState(false)
  const isVideo = project.project_type !== 'podcast'

  const set = <K extends keyof PublishDetailsInput>(key: K, value: PublishDetailsInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function addChapter(sourceStart: number, title = '') {
    setForm((f) => ({ ...f, chapters: [...f.chapters, { start: sourceStart, title }] }))
    setChapterTimes((t) => [...t, formatTime(sourceToOutputTime(sourceStart, keptRanges))])
  }

  function removeChapter(i: number) {
    setForm((f) => ({ ...f, chapters: f.chapters.filter((_, j) => j !== i) }))
    setChapterTimes((t) => t.filter((_, j) => j !== i))
  }

  function addFromTakes() {
    const existing = new Set(form.chapters.map((c) => c.start))
    ;(project.take_boundaries ?? []).forEach((b, i) => {
      if (!existing.has(b.start)) addChapter(b.start, `Part ${i + 1}`)
    })
  }

  const problems: string[] = []
  if (!SLUG.test(form.show)) problems.push("Show: the show's DarkRelay slug (lowercase letters, numbers and dashes)")
  if (!form.title.trim()) problems.push('Title is required')
  if (!form.notes.trim()) problems.push('Show notes are required')
  if (form.yt_title.length > YT_TITLE_MAX) problems.push(`YouTube title is over ${YT_TITLE_MAX} characters`)
  if (new TextEncoder().encode(form.yt_description).length > YT_DESCRIPTION_MAX_BYTES)
    problems.push(`YouTube description is over ${YT_DESCRIPTION_MAX_BYTES} bytes`)
  if (/[<>]/.test(form.yt_title + form.yt_description)) problems.push("YouTube doesn't allow < or >")
  chapterTimes.forEach((t, i) => {
    if (parseTime(t) === null) problems.push(`Chapter ${i + 1}: time should look like 12:34`)
  })

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const chapters: PublishChapter[] = form.chapters
        .map((c, i) => ({ title: c.title, start: outputToSourceTime(parseTime(chapterTimes[i]) ?? 0, keptRanges) }))
        .sort((a, b) => a.start - b.start)
      const details = {
        ...form,
        chapters,
        keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
      }
      onChange(await api.savePublishDetails(project.id, details))
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function uploadCover(file: File | undefined) {
    if (!file) return
    setCoverBusy(true)
    setError(null)
    try {
      onChange(await api.uploadCover(project.id, file))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setCoverBusy(false)
    }
  }

  async function removeCover() {
    setCoverBusy(true)
    try {
      onChange(await api.deleteCover(project.id))
    } finally {
      setCoverBusy(false)
    }
  }

  const cover = project.publish.cover

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
    >
      <div
        role="dialog"
        aria-labelledby="publish-dialog-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
          width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '20px 24px 0' }}>
          <div id="publish-dialog-title" style={{ fontWeight: 600, fontSize: 16 }}>Episode details for DarkRelay</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            Saved with the project. Nothing is uploaded from here.
          </div>
        </div>

        <div style={{ padding: '16px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <label style={label}>
              Show
              <input style={input} value={form.show} placeholder="my-show" onChange={(e) => set('show', e.target.value.trim())} />
            </label>
            <label style={label}>
              Episode title
              <input style={input} value={form.title} onChange={(e) => set('title', e.target.value)} />
            </label>
          </div>

          <label style={label}>
            Show notes (HTML, or plain text: blank lines start new paragraphs)
            <textarea
              style={{ ...input, minHeight: 110, resize: 'vertical' }}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <label style={label}>
              Type
              <select style={input} value={form.episode_type} onChange={(e) => set('episode_type', e.target.value as EpisodeType)}>
                <option value="full">Full</option>
                <option value="trailer">Trailer</option>
                <option value="bonus">Bonus</option>
              </select>
            </label>
            <label style={label}>
              Season
              <input
                style={input} type="number" min={1} value={form.season ?? ''}
                onChange={(e) => set('season', e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null)}
              />
            </label>
            <label style={label}>
              Episode
              <input
                style={input} type="number" min={1} value={form.episode ?? ''}
                onChange={(e) => set('episode', e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null)}
              />
            </label>
            <label style={label}>
              Explicit
              <select
                style={input}
                value={form.explicit === null ? '' : String(form.explicit)}
                onChange={(e) => set('explicit', e.target.value === '' ? null : e.target.value === 'true')}
              >
                <option value="">Show default</option>
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </label>
          </div>

          <label style={label}>
            Release (your local time; empty: as soon as it's published)
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ ...input, flex: 1 }} type="datetime-local" value={toLocalInput(form.pub_date)}
                onChange={(e) => set('pub_date', e.target.value ? new Date(e.target.value).toISOString() : null)}
              />
              {form.pub_date && <button style={smallButton} onClick={() => set('pub_date', null)}>Clear</button>}
            </div>
          </label>

          <label style={label}>
            Keywords (comma separated)
            <input style={input} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          </label>

          <div style={label}>
            Chapters (times in the edited episode)
            {form.chapters.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...input, width: 80, flexShrink: 0 }} value={chapterTimes[i]} aria-label={`Chapter ${i + 1} time`}
                  onChange={(e) => setChapterTimes((t) => t.map((v, j) => (j === i ? e.target.value : v)))}
                />
                <input
                  style={{ ...input, flex: 1 }} value={c.title} placeholder="Chapter title"
                  aria-label={`Chapter ${i + 1} title`}
                  onChange={(e) => set('chapters', form.chapters.map((ch, j) => (j === i ? { ...ch, title: e.target.value } : ch)))}
                />
                <button style={smallButton} onClick={() => removeChapter(i)} aria-label={`Remove chapter ${i + 1}`}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              {form.chapters.length === 0 && <button style={smallButton} onClick={() => addChapter(0, 'Intro')}>Add at 0:00</button>}
              <button style={smallButton} onClick={() => addChapter(currentTime)}>
                Add at playhead ({formatTime(sourceToOutputTime(currentTime, keptRanges))})
              </button>
              {(project.take_boundaries?.length ?? 0) > 1 && (
                <button style={smallButton} onClick={addFromTakes}>Add one per take</button>
              )}
            </div>
          </div>

          <div style={label}>
            Cover art (square JPEG or PNG, 1400 to 3000 px; empty: the show's)
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {cover && (
                <img
                  src={`/projects/${project.id}/files/${cover}`}
                  alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 4 }}
                />
              )}
              <input type="file" accept="image/jpeg,image/png" disabled={coverBusy}
                onChange={(e) => uploadCover(e.target.files?.[0])} style={{ fontSize: 12 }} />
              {cover && <button style={smallButton} onClick={removeCover} disabled={coverBusy}>Remove</button>}
            </div>
          </div>

          {isVideo && (
            <label style={{ ...label, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={form.include_video} onChange={(e) => set('include_video', e.target.checked)} />
              Include the full edit as video.mp4 (for a video show or YouTube)
            </label>
          )}

          <details>
            <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              YouTube title and description (optional; empty: the feed's)
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
              <label style={label}>
                YouTube title ({form.yt_title.length}/{YT_TITLE_MAX})
                <input style={input} value={form.yt_title} onChange={(e) => set('yt_title', e.target.value)} />
              </label>
              <label style={label}>
                YouTube description (plain text)
                <textarea
                  style={{ ...input, minHeight: 80, resize: 'vertical' }}
                  value={form.yt_description}
                  onChange={(e) => set('yt_description', e.target.value)}
                />
              </label>
            </div>
          </details>

          {(problems.length > 0 || error) && (
            <div style={{ fontSize: 12, color: '#e8a33d', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {problems.map((p) => <div key={p}>⚠ {p}</div>)}
              {error && <div style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '0 24px 20px' }}>
          <button onClick={onClose} style={{ ...smallButton, padding: '7px 18px', fontSize: 13 }}>Cancel</button>
          <button
            onClick={save}
            disabled={saving || chapterTimes.some((t) => parseTime(t) === null)}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
              padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
