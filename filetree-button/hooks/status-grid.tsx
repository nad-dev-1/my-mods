// The status-bar button grid, shared by every mod that puts a button on the
// status bar. Keep every copy identical: whichever mod's hook runs last lays
// out the whole bar, so each one must lay it out the same way.
//
// What the hooks beneath drew arrives as plain data. Every Button in it is
// gathered (each still answers its own mod's press), sorted into a fixed
// order and laid out in a grid of three rows, filled column by column, to the
// right edge of the bar, the status lines (the Box keyed `status-left`, kept
// as drawn) at its left edge.
// Anything else the hooks beneath drew is drawn again from `modes`.

/** Rows of the grid; the columns follow from the number of buttons. */
export const GRID_ROWS = 3

/** The grid's order by Button key: a column per purpose. Unknown keys go last. */
export const GRID_ORDER = [
  // Session controls
  'open-controls',
  'open-mod-manager',
  'open-handoff',
  // Prompt tools
  'open-inject',
  'open-prompt-upgrade',
  'open-replay',
  // Views
  'open-agent-dock',
  'toggle-filetree',
  'open-git-review',
  // Reports
  'open-work-report',
]

type TreeNode = { type?: unknown; key?: unknown; props?: Record<string, unknown>; children?: unknown }

function keyOf(node: TreeNode): string {
  const k = node.props?.key ?? node.key

  return typeof k === 'string' ? k : ''
}

type Found = { buttons: TreeNode[]; left: TreeNode | null; width: number | undefined }

/**
 * The Buttons of a tree in drawing order, its `status-left` part, and the
 * width a bar beneath was laid out to (Control Tools measures the room the
 * prompt really has, which shrinks while a dialog is docked beside it).
 */
function gather(node: unknown, found: Found): void {
  if (Array.isArray(node)) {
    for (const n of node) gather(n, found)

    return
  }
  if (!node || typeof node !== 'object') return
  const o = node as TreeNode
  const w = o.props?.width
  if (keyOf(o) === 'status-root' && found.width === undefined && typeof w === 'number' && w > 0) found.width = w
  if (keyOf(o) === 'status-left') {
    found.left ??= o

    return
  }
  if (o.type === 'Button') {
    found.buttons.push(o)

    return
  }
  gather(o.children ?? o.props?.children, found)
}

function rank(key: string): number {
  const at = GRID_ORDER.indexOf(key)

  return at < 0 ? GRID_ORDER.length : at
}

/**
 * The whole status bar: the modes and the status lines on the left, every
 * button in a three-row grid on the right. `mine` is the calling mod's own
 * Button, `left` its status lines when it draws them, `barWidth` the width
 * the bar draws into, when the caller knows it (Control Tools does); left
 * out, the width a bar beneath was laid out to is kept.
 */
export function statusGrid(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  els: { Box: any; Text: any },
  below: unknown,
  modes: readonly string[],
  mine: unknown,
  left?: unknown,
  barWidth?: number,
): unknown {
  const { Box, Text } = els
  const found: Found = { buttons: [], left: null, width: undefined }
  gather(below, found)
  const all = [...found.buttons, mine as TreeNode]
  const seen = new Set<string>()
  const buttons = all
    .filter(b => {
      const id = `${keyOf(b)}|${JSON.stringify((b as { press?: unknown }).press ?? '')}`
      if (seen.has(id)) return false
      seen.add(id)

      return true
    })
    .map((b, i) => ({ b, i, r: rank(keyOf(b)), k: keyOf(b) }))
    .sort((x, y) => x.r - y.r || x.k.localeCompare(y.k) || x.i - y.i)
    .map(x => x.b)
  const columns: TreeNode[][] = []
  buttons.forEach((b, i) => {
    const c = Math.floor(i / GRID_ROWS)
    ;(columns[c] ??= []).push(b)
  })
  const statusLines = left ?? found.left

  // The bar fills the width it is given: the status lines hold the left
  // edge, the grid the right edge.
  return (
    <Box
      key="status-root"
      flexDirection="row"
      alignItems="flex-start"
      justifyContent="space-between"
      flexGrow={1}
      width={barWidth && barWidth > 0 ? barWidth : found.width}
    >
      <Box key="status-left-side" flexDirection="row" flexShrink={1}>
        {modes.length > 0 ? <Text dimColor>{`${modes.join(' & ')}   `}</Text> : null}
        {statusLines ?? null}
      </Box>
      <Box key="status-grid" flexDirection="row" flexShrink={0} marginLeft={3}>
        {columns.map((col, i) => (
          <Box key={`status-grid-col-${i}`} flexDirection="column" marginRight={1}>
            {col}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
