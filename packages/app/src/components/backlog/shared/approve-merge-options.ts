// What each way of approving a story asks of the merge. Approve & Merge stays
// on this computer; only Approve, Merge & Push also publishes the target
// branch. Drag and drop to Done runs Approve & Merge.
export function approveMergeOptions(
  action: "Approve & Merge" | "Approve, Merge & Push"
): { push: boolean } {
  return { push: action === "Approve, Merge & Push" }
}
