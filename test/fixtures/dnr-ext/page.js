// Records what chrome.declarativeNetRequest does, for test/extensions.js.
window.dnrResult = (async () => {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr) return { present: false };
  await dnr.updateDynamicRules({ addRules: [{ id: 7, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'tracker.example' } }] });
  const rules = await dnr.getDynamicRules();
  await dnr.updateDynamicRules({ removeRuleIds: [7] });
  const after = await dnr.getDynamicRules();
  const alias = typeof browser !== 'undefined' && browser.runtime === chrome.runtime;
  window.browser = { own: true }; // pages may define their own
  const ownKept = window.browser.own === true;
  return { present: true, alias, ownKept, added: rules.map((r) => r.id), after: after.length, block: dnr.RuleActionType?.BLOCK, regex: (await dnr.isRegexSupported({ regex: 'a+' })).isSupported };
})();
