// Dependency-injected foreground queue. No UI, rendering, tokens, or fake timers.
// iOS suspension stops work; the next active session resumes confirmed progress.
async function runSelectionSync({ readPage, curate, upload, load, save, active, maxPages = 3, maxUploads = 72 }) {
  const state = await load() || { after: null, pending: null, completed: false, seen: {} };
  state.seen ||= {};
  if (state.completed) { state.after = null; state.completed = false; }
  let uploaded = 0;
  for (let pageNumber = 0; pageNumber < maxPages && active(); pageNumber++) {
    if (!state.pending) {
      const page = await readPage(state.after);
      if (!active()) return;
      const unreviewed = page.assets.filter(a => state.seen[a.id] !== (a.modificationTime || a.creationTime || 0));
      const { assets: result, reviewedIds } = await curate(unreviewed);
      if (!active()) return;
      // No minimum-count fallback: rejected photos never become upload candidates.
      state.pending = { assets: result, index: 0, after: page.endCursor,
                        hasNext: page.hasNextPage };
      const selected = new Set(result.map(a => a.id));
      const reviewed = new Set(reviewedIds);
      for (const asset of unreviewed) {
        if (reviewed.has(asset.id) && !selected.has(asset.id)) state.seen[asset.id] = asset.modificationTime || asset.creationTime || 0;
      }
      await save(state);
    }
    while (state.pending.index < state.pending.assets.length && active()) {
      const asset = state.pending.assets[state.pending.index];
      const confirmed = await upload(asset);
      // Commit only a server-confirmed upload. Interrupted requests may retry;
      // server content-addressing makes that safe and idempotent.
      state.pending.index++;
      if (confirmed !== false) state.seen[asset.id] = asset.modificationTime || asset.creationTime || 0;
      await save(state);
      if (++uploaded >= maxUploads) return;
    }
    if (!active()) return;
    state.after = state.pending.after;
    state.completed = !state.pending.hasNext;
    state.pending = null;
    await save(state);
    if (state.completed) return;
  }
}
module.exports = { runSelectionSync };
