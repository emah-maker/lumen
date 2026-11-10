chrome.runtime.sendMessage({ hello: true });
// A uBlock-style cosmetic filter for this frame: the top page hides a grid item that holds an ad (as uBlock's
// ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer) does on YouTube), a frame hides its own ad box. The page asks for the top rule
// back with postMessage('standin-uncss').
const css = window === top ? '#grid > .item:has(> .ad-slot) { display: none !important; }' : '.frame-ad { display: none !important; }';
chrome.runtime.sendMessage({ css });
addEventListener('message', (e) => { if (e.data === 'standin-uncss') chrome.runtime.sendMessage({ css, remove: true }); });
