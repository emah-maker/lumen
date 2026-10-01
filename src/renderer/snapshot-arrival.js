// What to do with a page snapshot once its image has decoded (freezePage in app.js). A plain script in the UI;
// test/units.js loads it with require().
//   'discard': a newer freeze or a thaw superseded this one while it decoded; revoke its blob URL and do nothing else.
//   'thaw':    the image is broken; revoke it and show the live page again.
//   'show':    swap it in.
(function (root) {
  function snapshotArrival({ token, current, decoded }) {
    if (token !== current) return 'discard';
    return decoded ? 'show' : 'thaw';
  }
  const api = { snapshotArrival };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.snapshotArrival = snapshotArrival;
})(typeof window !== 'undefined' ? window : globalThis);
