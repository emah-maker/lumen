// Electron does not turn a manifest's rulesets on by itself; uBlock Origin Lite turns its own on from its worker, and so does this stand-in.
chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['ads'] });
