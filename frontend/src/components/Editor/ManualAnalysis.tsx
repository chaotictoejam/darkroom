/**
 * Manual analysis fallback: copy the prompt, paste an EDL back in.
 */
import { useState } from 'react'
import { api } from '../../api/client'
import type { Project } from '../../api/types'

export default function ManualAnalysis({
  project,
  onChange,
  highlight,
}: {
  project: Project
  onChange: (p: Project) => void
  highlight: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [edlInput, setEdlInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  async function handleCopy() {
    const { prompt } = await api.getPrompt(project.id)
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleImport() {
    setImportError(null)
    setImporting(true)
    try {
      const edl = JSON.parse(edlInput)
      const updated = await api.importEdl(project.id, edl)
      onChange(updated)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Invalid JSON')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
        1. Copy the prompt and paste it into <strong style={{ color: highlight ? 'var(--accent)' : 'inherit' }}>Claude.ai</strong>.<br />
        2. Paste the JSON response back here and click Import.
      </p>
      <button
        onClick={handleCopy}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          color: 'var(--text)', borderRadius: 6, padding: '6px 12px',
          fontWeight: 500, fontSize: 12, cursor: 'pointer', alignSelf: 'flex-start',
        }}
      >
        {copied ? '✓ Copied!' : 'Copy prompt to clipboard'}
      </button>
      <textarea
        value={edlInput}
        onChange={(e) => setEdlInput(e.target.value)}
        placeholder="Paste the EDL JSON from Claude here…"
        rows={5}
        style={{
          resize: 'vertical', fontFamily: 'monospace', fontSize: 11,
          background: 'var(--bg-card)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6, padding: 8,
        }}
      />
      {importError && <p style={{ color: '#f55', fontSize: 12, margin: 0 }}>{importError}</p>}
      <button
        onClick={handleImport}
        disabled={!edlInput.trim() || importing}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 6, padding: '7px 14px', fontWeight: 600, fontSize: 12,
          alignSelf: 'flex-start', cursor: edlInput.trim() && !importing ? 'pointer' : 'default',
        }}
      >
        {importing ? 'Importing…' : 'Import EDL'}
      </button>
    </div>
  )
}
