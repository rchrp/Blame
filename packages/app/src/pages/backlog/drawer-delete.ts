/**
 * The drawer keeps a copy of the story it was opened on, so it would keep
 * rendering a story that has since been deleted. A delete may only close the
 * drawer when the drawer is showing that same story; deleting another story
 * must leave the open drawer alone.
 */
export function shouldCloseDrawerAfterDelete(
  drawerStoryId: string | undefined,
  deletedStoryId: string | undefined
): boolean {
  return drawerStoryId !== undefined && drawerStoryId === deletedStoryId
}
