/** One call to a connector, for its unfolded list. */
export type CallRow = { tool: string; summary: string; at: number; isSub: boolean }

/** Counts every row keeps: uses, uses by subagents, its order and when it last went up. */
export type Counted = { count: number; subCount: number; seq: number; bumpedAt: number }

export type ConnectorRow = Counted & { key: string; name: string; lastTool: string; calls: CallRow[] }
export type FileRow = Counted & { path: string; auto: boolean }
export type SkillRow = Counted & { name: string }
export type WebRow = Counted & { site: string; detail: string }

export type Inventory = { connectors: ConnectorRow[]; files: FileRow[]; skills: SkillRow[]; web: WebRow[] }

export type PlanStep = { text: string; status: 'pending' | 'in_progress' | 'completed'; id?: string }
export type Plan = { title: string; steps: PlanStep[]; updatedAt: number }

export type AgentRow = { id: string; type: string; description: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'chat-inventory': {
      /** What this chat used: connectors, files, skills, web pages. */
      inv: Shaped<Inventory>
      /** Claude's own task list (TodoWrite, TaskCreate, TaskUpdate). */
      tasks: Shaped<Plan>
      /** Clean View's checklist (plan_steps, report_progress). */
      steps: Shaped<Plan>
      /** The subagents of this chat, as `$.agent.list()` last gave them. */
      agents: Shaped<AgentRow[]>
      /** Cards folded by their header. */
      folded: string[]
      /** The connector whose calls are unfolded; '' when none. */
      openConnector: string
      /** The first context file row shown. */
      fileTop: number
      /** True while the pane is open, so the button closes it. */
      isOpen: boolean
      /** The clock, moved while a count is lit, so the light goes out. */
      now: number
      /** A short line under the header after Copy or a failed open; '' when none. */
      note: string
    }
  }
}
