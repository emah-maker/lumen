// What an extension asks for, in the words Chrome's install prompt uses, so the "Add extension?"
// dialog can list it before anything is installed.
const WARNINGS = {
  '<all_urls>': 'Read and change all your data on all websites',
  bookmarks: 'Read and change your bookmarks',
  clipboardRead: 'Read data you copy and paste',
  clipboardWrite: 'Modify data you copy and paste',
  contentSettings: 'Change your settings that control websites\' access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc.',
  cookies: 'Read and change cookies on the sites it can access',
  debugger: 'Access the page debugger backend',
  declarativeNetRequest: 'Block content on any page',
  declarativeNetRequestFeedback: 'Read your browsing history',
  desktopCapture: 'Capture content of your screen',
  downloads: 'Manage your downloads',
  geolocation: 'Detect your physical location',
  history: 'Read and change your browsing history on all your signed-in devices',
  management: 'Manage your apps, extensions, and themes',
  nativeMessaging: 'Communicate with cooperating native applications',
  notifications: 'Display notifications',
  privacy: 'Change your privacy-related settings',
  proxy: 'Read and change all your data on all websites',
  scripting: 'Read and change data on the websites it can access',
  tabCapture: 'Read and change all your data on all websites',
  tabs: 'Read your browsing history',
  topSites: 'Read a list of your most frequently visited websites',
  webNavigation: 'Read your browsing history',
  webRequest: 'Read and change all your data on all websites',
};

const ALL_HOSTS = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|\*:\/\/\*\/|https?:\/\/\*\/)$/;
const hostOf = (pattern) => pattern.replace(/^[^:]+:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');

// Returns the list of lines to show, most sweeping first; an empty list means it asks for nothing
// that Chrome would warn about.
function extensionPermissionLines(manifest = {}) {
  const permissions = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].filter((p) => typeof p === 'string');
  const hosts = [
    ...(manifest.host_permissions || []),
    ...permissions.filter((p) => p.includes('://') || p === '<all_urls>'),
    ...(manifest.content_scripts || []).flatMap((c) => c.matches || []),
  ].filter((h) => typeof h === 'string');
  const lines = [];
  if (hosts.some((h) => ALL_HOSTS.test(h))) lines.push(WARNINGS['<all_urls>']);
  else {
    const sites = [...new Set(hosts.map(hostOf).filter(Boolean))];
    if (sites.length) lines.push(`Read and change your data on ${sites.length > 3 ? `${sites.slice(0, 3).join(', ')} and ${sites.length - 3} more` : sites.join(', ')}`);
  }
  for (const p of permissions) {
    const line = WARNINGS[p];
    if (line && p !== '<all_urls>' && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

module.exports = { extensionPermissionLines };
