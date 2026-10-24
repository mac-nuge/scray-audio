/* View history shared by the website and both bundled apps. Uses real browser
 * history, but the in-player buttons never go past the player's first view. */
(() => {
  'use strict';
  const back = document.getElementById('navback'), forward = document.getElementById('navforward');
  if (!back || !forward) return;
  const key = 'scrayAudio.viewHistory';
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(key)); } catch {}
  const mark = history.state?.scrayView;
  let trail = saved && Array.isArray(saved.views) && mark?.id === saved.id && saved.views[mark.index] === location.hash
    ? { ...saved, index: mark.index }
    : { id: Date.now().toString(36) + Math.random().toString(36).slice(2), index: 0, views: [location.hash] };
  let moving = false;
  function paint() {
    back.disabled = moving || trail.index === 0;
    forward.disabled = moving || trail.index >= trail.views.length - 1;
  }
  function save(hash) {
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    if (hash !== undefined || state.scrayView?.id !== trail.id || state.scrayView?.index !== trail.index) {
      history.replaceState({ ...state, scrayView: { id: trail.id, index: trail.index } }, '', hash === undefined ? location.href : hash);
    }
    try { sessionStorage.setItem(key, JSON.stringify(trail)); } catch {}
    paint();
  }
  function sync() {
    const state = history.state?.scrayView;
    if (state?.id === trail.id && trail.views[state.index] === location.hash) trail.index = state.index;
    else {
      trail.views.splice(trail.index + 1);
      trail.views.push(location.hash);
      trail.index++;
    }
    moving = false;
    save();
  }
  back.addEventListener('click', () => { if (!back.disabled) { moving = true; paint(); history.back(); } });
  forward.addEventListener('click', () => { if (!forward.disabled) { moving = true; paint(); history.forward(); } });
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  window.addEventListener('pageshow', () => { moving = false; paint(); });
  window.ScrayNavigation = {
    // Typing edits the current search view, rather than adding one entry per letter.
    replace(hash) {
      trail.views[trail.index] = hash;
      save(hash);
    },
  };
  save();
})();
