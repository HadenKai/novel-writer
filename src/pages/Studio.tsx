import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Workspace from './Workspace'
import Manuscript from './Manuscript'
import Refine from './Refine'
import Library from './Library'
import { isStudioTab, type StudioTab, type WorkspacePane } from './studio-tabs'
import './writing.css'

/** 单层作品模式导航；章节深链和现有 tab/sub URL 保持兼容。 */
export default function Studio() {
  const { id, cid } = useParams()
  const [sp] = useSearchParams()
  const nav = useNavigate()
  const tab: StudioTab = cid ? 'write' : isStudioTab(sp.get('tab')) ? (sp.get('tab') as StudioTab) : 'write'
  const sub = sp.get('sub')

  if (!id) return null

  return (
    <div className="writing-studio">
      <div className="writing-content" data-tab={tab}>
        {tab === 'bible' || tab === 'outline' ? (
          <Workspace pane={tab as WorkspacePane} sub={sub} onSub={k => nav(`/novel/${id}?tab=${tab}&sub=${k}`)} />
        ) : tab === 'write' ? (
          <Manuscript key={id} />
        ) : tab === 'refine' ? (
          <Refine />
        ) : (
          <Library />
        )}
      </div>
    </div>
  )
}
