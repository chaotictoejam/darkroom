/**
 * Collapsible section in the editor sidebar.
 */
export default function SidebarSection({
  label,
  open,
  onToggle,
  danger,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={{
      borderTop: danger ? '1px solid rgba(180,50,50,0.3)' : 'none',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', background: 'none', border: 'none',
          color: open ? (danger ? '#c96' : 'var(--text)') : 'var(--text-muted)',
          fontSize: 13, fontWeight: open ? 600 : 400,
          cursor: 'pointer', textAlign: 'left',
          transition: 'color 0.1s',
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', maxHeight: 420, overflowY: 'auto' }}>
          {children}
        </div>
      )}
    </div>
  )
}
