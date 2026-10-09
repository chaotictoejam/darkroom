/**
 * Sidebar tools: export the transcript or EDL, and redo manual analysis.
 */
import { useState } from 'react'
import { api } from '../../api/client'
import type { Project } from '../../api/types'
import { formatTimestamp } from '../../formatTime'

export default function AdvancedTools({
  project,
  onChange,
  onOpenManualAnalysis,
}: {
  project: Project
  onChange: (p: Project) => void
  onOpenManualAnalysis: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)

  function exportTranscript() {
    const lines = project.merged_transcript.map(
      (seg) => `[${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}] ${seg.speaker_name}\n${seg.text}`,
    )
    download(`${project.name}-transcript.txt`, lines.join('\n\n'), 'text/plain')
  }

  function exportEdl() {
    if (!project.edl) return
    download(
      `${project.name}-edl.json`,
      JSON.stringify(project.edl, null, 2),
      'application/json',
    )
  }

  async function handleRedoConfirm() {
    setResetting(true)
    try {
      const updated = await api.resetEdl(project.id)
      onChange(updated)
      const { prompt } = await api.getPrompt(project.id)
      await navigator.clipboard.writeText(prompt)
      onOpenManualAnalysis()
    } finally {
      setResetting(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <AdvBtn label="Export Transcript" onClick={exportTranscript} />
        <AdvBtn label="Export EDL" onClick={exportEdl} disabled={!project.edl} />
        <div style={{ height: 1, background: 'rgba(180,50,50,0.2)', margin: '4px 0' }} />
        <AdvBtn label="Redo Manual Analysis" onClick={() => setConfirming(true)} warning />
      </div>

      {confirming && (
        <div
          onClick={() => setConfirming(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '28px 32px',
              width: 360,
              display: 'flex', flexDirection: 'column', gap: 20,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Redo Manual Analysis?</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5 }}>
                This will clear the current EDL and copy the analysis prompt to your clipboard.
                Paste it into Claude to generate a new EDL.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirming(false)}
                disabled={resetting}
                style={{
                  background: 'none', border: '1px solid var(--border)',
                  color: 'var(--text)', borderRadius: 6, padding: '7px 18px',
                  fontSize: 13, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleRedoConfirm}
                disabled={resetting}
                style={{
                  background: 'var(--accent)', border: 'none',
                  color: '#fff', borderRadius: 6, padding: '7px 18px',
                  fontSize: 13, fontWeight: 600, cursor: resetting ? 'default' : 'pointer',
                }}
              >
                {resetting ? 'Resetting…' : 'Clear EDL & Copy Prompt'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function AdvBtn({
  label,
  onClick,
  disabled,
  warning,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  warning?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', textAlign: 'left',
        background: 'none',
        border: `1px solid ${warning ? 'rgba(180,50,50,0.35)' : 'var(--border)'}`,
        borderRadius: 6, padding: '6px 10px',
        color: disabled ? 'var(--text-muted)' : warning ? '#c96' : 'var(--text)',
        fontSize: 12, cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {label}
    </button>
  )
}

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}
