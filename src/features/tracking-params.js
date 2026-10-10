// Tracking parameters taken off the addresses pages are opened at (setting stripTrackingParams; adblock.js calls
// strip() for every top-level navigation, and the page loads at the clean address instead). Only parameters that
// exist to say where a click came from: campaign tags (utm_*), ad-click ids (gclid, fbclid, msclkid…) and mail
// trackers (mc_eid, _hsenc…). Nothing a page needs to work is on the list, so a link still opens what it pointed at.
// The rest of the query is kept byte for byte (not re-encoded), in its order.

// Removed on every site.
const EVERYWHERE = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'ttclid', 'twclid', 'li_fat_id', 'igshid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsctatracking', 'mkt_tok', 'oly_anon_id', 'oly_enc_id',
  'vero_id', 'vero_conv', 'rb_clickid', 'wickedid', '_openstat', 'epik', 'srsltid', 'sccid', 's_kwcid', 'ef_id', '_kx', 'irclickid',
]);
const PREFIXES = ['utm_', 'pk_campaign', 'pk_kwd', 'pk_source', 'pk_medium', 'mtm_'];
// Share ids that name who shared a link: removed only where they mean that (`si` is an ordinary word elsewhere).
const BY_HOST = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, new Set(['si', 'pp', 'feature'])],
  [/(^|\.)spotify\.com$/, new Set(['si'])],
  [/(^|\.)instagram\.com$/, new Set(['igsh', 'img_index'])],
  [/(^|\.)(twitter\.com|x\.com)$/, new Set(['s', 't', 'ref_src', 'ref_url'])],
  [/(^|\.)tiktok\.com$/, new Set(['_r', '_t', 'is_from_webapp', 'sender_device', 'share_app_id', 'share_link_id', 'tt_from', 'u_code'])],
  [/(^|\.)amazon\.[a-z.]+$/, new Set(['pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r', 'pd_rd_i', 'ref_', 'content-id', 'crid', 'sprefix', 'qid'])],
  [/(^|\.)linkedin\.com$/, new Set(['trk', 'trackingid', 'refid', 'lipi'])],
];
// Sign-in and payment pages are never touched: their parameters are checked against a signature.
const LEAVE = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com|paypal\.com|stripe\.com)$/;

const decodeName = (raw) => {
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase(); } catch { return raw.toLowerCase(); }
};

function tracking(name, extra) {
  if (EVERYWHERE.has(name) || (extra && extra.has(name))) return true;
  return PREFIXES.some((p) => name.startsWith(p));
}

// The address without its tracking parameters, or the same string when there were none.
function strip(url) {
  if (typeof url !== 'string' || !/^https?:\/\/[^?#]*\?/i.test(url)) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (LEAVE.test(u.hostname)) return url;
  const extra = BY_HOST.find(([re]) => re.test(u.hostname))?.[1];
  const q = url.indexOf('?');
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const pairs = query.split('&');
  const kept = pairs.filter((pair) => pair && !tracking(decodeName(pair.split('=')[0]), extra));
  if (kept.length === pairs.filter(Boolean).length) return url;
  return url.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '') + (hash === -1 ? '' : url.slice(hash));
}

module.exports = { strip };
