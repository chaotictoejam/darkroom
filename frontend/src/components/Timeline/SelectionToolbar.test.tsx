import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SelectionToolbar from './SelectionToolbar'

function renderToolbar(props: Partial<Parameters<typeof SelectionToolbar>[0]> = {}) {
  const handlers = { onCut: vi.fn(), onRestore: vi.fn(), onClose: vi.fn() }
  render(<SelectionToolbar center={50} length={1.234} canRestore={false} {...handlers} {...props} />)
  return handlers
}

describe('SelectionToolbar', () => {
  it('shows the selection length on the Cut button and cuts on click', () => {
    const { onCut } = renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: /Cut 1\.23s/ }))
    expect(onCut).toHaveBeenCalledOnce()
  })

  it('offers Restore only when the selection holds cuts', () => {
    renderToolbar()
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
  })

  it('restores on click', () => {
    const { onRestore } = renderToolbar({ canRestore: true })
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }))
    expect(onRestore).toHaveBeenCalledOnce()
  })

  it('clears the selection with the close button', () => {
    const { onClose } = renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps its pointer presses from reaching the track', () => {
    const onTrackPointerDown = vi.fn()
    render(
      <div onPointerDown={onTrackPointerDown}>
        <SelectionToolbar center={50} length={1} canRestore onCut={() => {}} onRestore={() => {}} onClose={() => {}} />
      </div>,
    )
    for (const button of screen.getAllByRole('button')) fireEvent.pointerDown(button)
    expect(onTrackPointerDown).not.toHaveBeenCalled()
  })

  it('highlights a button on hover', () => {
    renderToolbar()
    const cut = screen.getByRole('button', { name: /Cut/ })
    fireEvent.mouseEnter(cut)
    expect(cut.style.background).toBe('rgb(46, 46, 46)')
    fireEvent.mouseLeave(cut)
    expect(cut.style.background).toBe('none')
  })

  it('stays on screen near the track edges', () => {
    const { rerender } = render(<SelectionToolbar center={1} length={1} canRestore={false} onCut={() => {}} onRestore={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('toolbar').style.left).toBe('5%')
    rerender(<SelectionToolbar center={99} length={1} canRestore={false} onCut={() => {}} onRestore={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('toolbar').style.left).toBe('95%')
    rerender(<SelectionToolbar center={40} length={1} canRestore={false} onCut={() => {}} onRestore={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('toolbar').style.left).toBe('40%')
  })
})
