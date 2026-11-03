// [secure DNS] Settings → Advanced → Network and proxy → Secure DNS, as in Chrome's "Use secure DNS": which DNS-over-HTTPS
// server Lumen asks for site addresses. Pure: settings-backend.js passes resolverConfig() to app.configureHostResolver.
//
// Why: a network's own DNS can hand out an address that network can't reach. On the user's campus network (2026-11-03)
// muse.ai resolved to a Meta edge (57.144.204.141) that never answered, so Muse timed out in Lumen and in Chrome alike;
// Cloudflare and Google answered with other Meta edges that load at once.
//
// 'auto' leaves Chromium's own behaviour alone (secure DNS only when the system's DNS provider offers it, Chrome's
// default). A provider is used in Chromium's secure mode, as Chrome's "With Cloudflare": only it answers. (Automatic mode with
// the provider named, which would fall back to the system's DNS, was tried first: Chromium kept to the system's DNS on that
// network, as it does when Windows' DNS settings have options it can't follow, and Muse still timed out.) So a name only the
// local network knows (an intranet host) doesn't resolve while a provider is chosen; Settings says so.
'use strict';

const PROVIDERS = {
  cloudflare: 'https://chrome.cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query{?dns}',
  quad9: 'https://dns.quad9.net/dns-query',
};
const CHOICES = ['auto', 'off', ...Object.keys(PROVIDERS), 'custom'];
const MAX_TEMPLATE = 300;

// A typed server address (a DoH URI template, RFC 8484): https only, no credentials, spaces or quotes. '' when unusable.
function cleanTemplate(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > MAX_TEMPLATE || !/^https:\/\//i.test(t) || /[\s"'<>\\]/.test(t)) return '';
  try {
    const u = new URL(t.replace(/\{[^}]*\}/g, '')); // ({?dns} is a template variable, not part of the address)
    return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password ? t : '';
  } catch { return ''; }
}

const cleanChoice = (v) => (CHOICES.includes(v) ? v : null);

// The choice and the custom address -> the options for app.configureHostResolver, or null for "leave Chromium's default".
// A custom choice without a usable address is the default too.
function resolverConfig(choice, custom) {
  if (choice === 'off') return { secureDnsMode: 'off', secureDnsServers: [] };
  const server = PROVIDERS[choice] || (choice === 'custom' ? cleanTemplate(custom) : '');
  return server ? { secureDnsMode: 'secure', secureDnsServers: [server] } : null;
}

// What Chromium starts with, to go back to after a provider was chosen: automatic, upgrading only the system's own DNS.
const DEFAULT_CONFIG = { secureDnsMode: 'automatic', secureDnsServers: [] };

module.exports = { PROVIDERS, CHOICES, cleanChoice, cleanTemplate, resolverConfig, DEFAULT_CONFIG };
