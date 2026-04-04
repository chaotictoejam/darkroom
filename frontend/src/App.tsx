import { useState } from 'react'
import type { Project } from './api/types'
import Welcome from './views/Welcome'
import Setup from './views/Setup'
import Processing from './views/Processing'
import Editor from './views/Editor'

export type AppView = 'welcome' | 'setup' | 'processing' | 'editor'

export default function App() {
  const [view, setView] = useState<AppView>('welcome')
  const [project, setProject] = useState<Project | null>(null)

  function openProject(proj: Project) {
    setProject(proj)
    // Route to the correct view based on current project status
    if (proj.status === 'created' || proj.status === 'uploaded') {
      setView('setup')
    } else if (proj.status === 'transcribing' || proj.status === 'analyzing' || proj.status === 'rendering') {
      setView('processing')
    } else {
      setView('editor')
    }
  }

  function startNewProject(proj: Project) {
    setProject(proj)
    setView('setup')
  }

  return (
    <>
      {view === 'welcome' && (
        <Welcome
          onNewProject={startNewProject}
          onOpenProject={openProject}
        />
      )}
      {view === 'setup' && project && (
        <Setup
          project={project}
          onBack={() => setView('welcome')}
          onProcessing={(proj) => { setProject(proj); setView('processing') }}
        />
      )}
      {view === 'processing' && project && (
        <Processing
          project={project}
          onComplete={(proj) => { setProject(proj); setView('editor') }}
          onError={(proj) => setProject(proj)}
        />
      )}
      {view === 'editor' && project && (
        <Editor
          project={project}
          onChange={setProject}
          onBack={() => setView('welcome')}
        />
      )}
    </>
  )
}
