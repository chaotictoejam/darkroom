/**
 * Music & sound panel: the global library on top, the cues placed in this
 * project below.
 *
 * The library is shared by every project and lives outside them, so an intro or
 * a bed is imported once and reused. Importing copies the file into the library
 * and measures it locally — nothing is uploaded anywhere.
 *
 * A cue's level is set relative to the voice, so −14 dB means the same thing
 * under every episode, and ducking uses the transcript: the music drops by the
 * duck amount whenever anyone is talking and comes back up in the gaps.
 */
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import type { LibraryTrack, Project, SoundCue, SoundCueKind, SoundTrack } from '../../api/types'
import { formatTimecode } from '../../formatTime'
import {
  bedEnding, cueBlocks, formatDb, kindLabel, newCue, replaceCue, setBedEnding,
  type BedEnding,
} from '../Timeline/musicCues'
import type { TimeRange } from '../Timeline/timeMap'

const KINDS: { kind: SoundCueKind; label: string; hint: string }[] = [
  { kind: 'intro', label: 'Intro', hint: 'Starts the episode, ducking once the talking begins' },
  { kind: 'bed', label: 'Bed here', hint: 'Plays under the voices from the playhead on' },
  { kind: 'outro', label: 'Outro', hint: 'Ends the episode' },
  { kind: 'sfx', label: 'Effect here', hint: 'A one-shot at the playhead' },
]

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const smallBtn: React.CSSProperties = {
  background: 'var(--bg-card)', color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 5, padding: '2px 7px', fontSize: 11, cursor: 'pointer',
}
const label: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)' }

/** Where a bed stops, and what each choice means in the mix. */
const ENDINGS: { ending: BedEnding; label: string; hint: string }[] = [
  { ending: 'episode', label: 'End of episode', hint: 'Keeps going under the whole episode, repeating as often as it must' },
  { ending: 'track', label: 'Track runs out', hint: 'Plays the file once and fades out where it ends' },
  { ending: 'time', label: 'At the playhead', hint: 'Stops where the playhead is now, repeating to fill if the file is shorter' },
]

function seconds(value: number): string {
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}

export default function MusicPanel({
  project,
  currentTime,
  duration,
  keptRanges,
  library,
  loading,
  onLibraryChange,
  selectedCueId,
  onSelectCue,
  onCuesChange,
}: {
  project: Project
  /** Playhead position in source seconds — where "here" means. */
  currentTime: number
  /** Length of the source recording, which is as late as a cue can be placed. */
  duration: number
  keptRanges: TimeRange[]
  /** The global library, owned by the editor so the timeline can label cues. */
  library: LibraryTrack[]
  loading: boolean
  onLibraryChange: (tracks: LibraryTrack[]) => void
  selectedCueId: string | null
  onSelectCue: (cueId: string | null) => void
  /** Save the cues (and sound tracks) and rebuild the preview mix. */
  onCuesChange: (cues: SoundCue[], tracks?: SoundTrack[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = picked && library.some((t) => t.id === picked) ? picked : library[0]?.id ?? null
  const [playing, setPlaying] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const cues = project.sound_cues ?? []
  const tracks = project.sound_tracks ?? []
  const soundTrack = tracks[0]
  const blocks = cueBlocks(cues, library, keptRanges, duration)

  async function importFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.importMusic(Array.from(files))
      onLibraryChange(res.tracks)
      if (res.added[0]) setPicked(res.added[0].id)
      if (res.errors.length > 0) {
        setError(res.errors.map((e) => `${e.name}: ${e.error}`).join('; '))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function togglePlay(track: LibraryTrack) {
    audioRef.current?.pause()
    if (playing === track.id) {
      setPlaying(null)
      return
    }
    const audio = new Audio(api.musicFileUrl(track.id))
    audio.onended = () => setPlaying(null)
    audioRef.current = audio
    void audio.play().catch(() => setPlaying(null))
    setPlaying(track.id)
  }

  async function removeTrack(track: LibraryTrack) {
    setBusy(true)
    try {
      await api.deleteMusic(track.id)
      onLibraryChange(library.filter((t) => t.id !== track.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the track')
    } finally {
      setBusy(false)
    }
  }

  function addCue(kind: SoundCueKind) {
    const track = library.find((t) => t.id === chosen)
    if (!track) return
    const cue = newCue(track, kind, currentTime, `c${Date.now().toString(36)}`)
    onSelectCue(cue.id)
    onCuesChange([...cues, cue])
  }

  function updateCue(cue: SoundCue) {
    onCuesChange(replaceCue(cues, cue))
  }

  function removeCue(cue: SoundCue) {
    if (selectedCueId === cue.id) onSelectCue(null)
    onCuesChange(cues.filter((c) => c.id !== cue.id))
  }

  function setTrackField(patch: Partial<SoundTrack>) {
    if (!soundTrack) return
    onCuesChange(cues, [{ ...soundTrack, ...patch }, ...tracks.slice(1)])
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Library ──────────────────────────────────────────────────────── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Library</span>
          <button style={smallBtn} disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Importing…' : '+ Add music'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          multiple
          aria-label="Add music files to the library"
          onChange={(e) => importFiles(e.target.files)}
          style={{ display: 'none' }}
        />
        <p style={{ ...label, margin: 0 }}>
          Shared by every project and kept on this computer. Nothing is uploaded — add only
          music you have the rights to use.
        </p>

        {loading ? (
          <span style={label}>Reading the library…</span>
        ) : library.length === 0 ? (
          <span style={label}>Empty. Add an intro, an outro or a loop to get started.</span>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {library.map((track) => (
              <li
                key={track.id}
                style={{
                  ...row,
                  background: chosen === track.id ? 'rgba(59,130,246,0.18)' : 'var(--bg-card)',
                  border: `1px solid ${chosen === track.id ? 'rgba(59,130,246,0.8)' : 'var(--border)'}`,
                  borderRadius: 5, padding: '3px 5px',
                }}
              >
                <button
                  onClick={() => togglePlay(track)}
                  title={playing === track.id ? 'Stop' : 'Listen'}
                  aria-label={playing === track.id ? `Stop ${track.name}` : `Listen to ${track.name}`}
                  style={{ ...smallBtn, padding: '0 5px', background: 'none', border: 'none' }}
                >
                  {playing === track.id ? '■' : '▶'}
                </button>
                <button
                  onClick={() => setPicked(track.id)}
                  title="Use this track"
                  style={{
                    flex: 1, textAlign: 'left', background: 'none', border: 'none',
                    color: 'var(--text)', fontSize: 11, cursor: 'pointer', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0,
                  }}
                >
                  {track.name}
                </button>
                <span style={{ ...label, fontFamily: 'monospace' }}>{seconds(track.duration)}</span>
                <button
                  onClick={() => removeTrack(track)}
                  title="Remove from the library"
                  aria-label={`Remove ${track.name} from the library`}
                  style={{ ...smallBtn, background: 'none', border: 'none', color: 'var(--text-muted)', padding: '0 2px' }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <span style={{ fontSize: 11, color: '#f55' }}>{error}</span>}

        {library.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {KINDS.map(({ kind, label: text, hint }) => (
              <button
                key={kind}
                style={smallBtn}
                disabled={!chosen}
                title={hint}
                onClick={() => addCue(kind)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── Cues in this project ─────────────────────────────────────────── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            In this episode{cues.length > 0 ? ` · ${cues.length}` : ''}
          </span>
          {soundTrack && cues.length > 0 && (
            <button
              style={{
                ...smallBtn,
                color: soundTrack.muted ? '#e8a33d' : 'var(--text-muted)',
              }}
              aria-pressed={soundTrack.muted}
              onClick={() => setTrackField({ muted: !soundTrack.muted })}
              title="Silence every cue without removing them"
            >
              {soundTrack.muted ? 'Muted' : 'Mute'}
            </button>
          )}
        </div>

        {cues.length === 0 ? (
          <span style={label}>
            Nothing placed yet. Pick a track above, then put it at the start or under the
            voices from the playhead.
          </span>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {blocks.map(({ cue, start, name, missing }) => {
              const open = selectedCueId === cue.id
              return (
                <li
                  key={cue.id}
                  style={{
                    background: 'var(--bg-card)', borderRadius: 6,
                    border: `1px solid ${open ? 'rgba(59,130,246,0.8)' : 'var(--border)'}`,
                    padding: 6, display: 'flex', flexDirection: 'column', gap: 6,
                  }}
                >
                  <div style={row}>
                    <button
                      onClick={() => onSelectCue(open ? null : cue.id)}
                      aria-expanded={open}
                      style={{
                        flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0,
                        color: missing ? '#e8a33d' : 'var(--text)', fontSize: 11, cursor: 'pointer',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {missing ? '⚠ ' : ''}{name}
                      <span style={{ color: 'var(--text-muted)' }}>
                        {` · ${kindLabel(cue.kind)}`}
                        {cue.kind === 'bed' || cue.kind === 'sfx' ? ` · ${formatTimecode(start)}` : ''}
                      </span>
                    </button>
                    <span style={{ ...label, fontFamily: 'monospace' }}>{formatDb(cue.gain_db)}</span>
                    <button
                      onClick={() => removeCue(cue)}
                      aria-label={`Remove ${name}`}
                      title="Remove this cue"
                      style={{ ...smallBtn, background: 'none', border: 'none', color: 'var(--text-muted)', padding: '0 2px' }}
                    >
                      ×
                    </button>
                  </div>

                  {open && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ ...label, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span>Level under the voice · {formatDb(cue.gain_db)}</span>
                        <input
                          type="range"
                          min={-40}
                          max={6}
                          step={0.5}
                          value={cue.gain_db}
                          onChange={(e) => updateCue({ ...cue, gain_db: Number(e.target.value) })}
                        />
                      </label>

                      <label style={{ ...row, ...label }}>
                        <input
                          type="checkbox"
                          checked={cue.duck}
                          onChange={(e) => updateCue({ ...cue, duck: e.target.checked })}
                        />
                        Duck while anyone is talking
                      </label>

                      {cue.duck && (
                        <label style={{ ...label, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span>How far down · {formatDb(cue.duck_db)}</span>
                          <input
                            type="range"
                            min={-30}
                            max={0}
                            step={0.5}
                            value={cue.duck_db}
                            onChange={(e) => updateCue({ ...cue, duck_db: Number(e.target.value) })}
                          />
                        </label>
                      )}

                      <div style={{ ...row, flexWrap: 'wrap' }}>
                        <label style={{ ...row, ...label }}>
                          <input
                            type="checkbox"
                            checked={cue.loop}
                            onChange={(e) => updateCue({ ...cue, loop: e.target.checked })}
                          />
                          Loop
                        </label>
                        <label style={{ ...row, ...label }}>
                          Fade in
                          <input
                            type="number"
                            min={0}
                            max={30}
                            step={0.5}
                            value={cue.fade_in}
                            onChange={(e) => updateCue({ ...cue, fade_in: Number(e.target.value) })}
                            style={{ width: 44, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11 }}
                          />
                        </label>
                        <label style={{ ...row, ...label }}>
                          out
                          <input
                            type="number"
                            min={0}
                            max={30}
                            step={0.5}
                            value={cue.fade_out}
                            onChange={(e) => updateCue({ ...cue, fade_out: Number(e.target.value) })}
                            style={{ width: 44, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11 }}
                          />
                        </label>
                      </div>

                      {cue.kind === 'bed' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={label}>Ends</span>
                          <div style={{ ...row, flexWrap: 'wrap' }} role="group" aria-label="Where the bed ends">
                            {ENDINGS.map(({ ending, label: text, hint }) => {
                              const active = bedEnding(cue) === ending
                              return (
                                <button
                                  key={ending}
                                  title={hint}
                                  aria-pressed={active}
                                  onClick={() =>
                                    updateCue(setBedEnding(cue, ending, currentTime, duration))
                                  }
                                  style={{
                                    ...smallBtn,
                                    background: active ? 'var(--accent)' : 'var(--bg-card)',
                                    color: active ? '#fff' : 'var(--text)',
                                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                                    fontWeight: active ? 600 : 400,
                                  }}
                                >
                                  {text}
                                </button>
                              )
                            })}
                          </div>
                          <span style={label}>
                            {cue.until !== null
                              ? `Stops at ${formatTimecode(cue.until)} — click “At the playhead” again to move it, or drag its right edge on the timeline.`
                              : cue.loop
                                ? 'Runs to the last word, repeating as often as it must.'
                                : 'Plays once and stops when the file runs out.'}
                          </span>
                        </div>
                      )}
                      {missing && (
                        <span style={{ fontSize: 11, color: '#e8a33d' }}>
                          This track is no longer in the library, so the cue plays nothing.
                        </span>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {cues.length > 0 && (
          <span style={label}>
            {project.project_type === 'podcast'
              ? 'The preview plays a rendered mix, so what you hear is what exports.'
              : 'Cues are mixed into the preview and every export.'}
          </span>
        )}
      </section>
    </div>
  )
}
