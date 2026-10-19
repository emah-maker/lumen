// Device access for WebHID, WebUSB and Web Serial, as in Chrome: a site calls navigator.hid / usb / serial
// .requestDevice(), Lumen shows a chooser ("example.com wants to connect to a HID device"), and only the device the
// user picks becomes that site's. Without this, the request failed outright (Electron has no chooser of its own), so a
// keyboard configurator or a flasher could never connect.
//
//   - The permission check ('hid' | 'usb' | 'serial') passes for http(s) origins only (never Lumen's own pages); Electron
//     gives it no tab, so tabs are refused in the chooser: not a tab the AI opened, not an agent's window or a music
//     card (research tabs live in a session that refuses everything). Chromium requires a user gesture for requestDevice.
//   - select-*-device / select-serial-port: the event is taken over, features/dialogs.js draws the chooser over the
//     asking tab's window, and the answer goes back as the device's id (nothing at all cancels). The list follows
//     devices plugged in and out while it is open. Only a real click or key in the card can choose (see dialogs.js), so
//     no AI tool or script can open the chooser's Connect, and a request from a page the AI controls is cancelled
//     without ever being shown.
//   - What the user picked is remembered per origin and device identity (browser/device-permissions.js), in
//     settings.json for the normal profile and in memory for a private window. device.forget() (the *-revoked events)
//     and Settings > Site permissions remove it.
//   - Security keys (FIDO) are never offered, and USB's protected classes stay as Chromium has them.
//
// deps: { dialogs (features/dialogs.js), t, ordinary(wc) -> bool, webContentsFromFrame(frame) }.
const P = require('../browser/device-permissions');

const TYPES = P.TYPES;

function createDeviceChooser(deps) {
  const { dialogs, t } = deps;
  const ordinary = (wc) => { try { return Boolean(wc) && !wc.isDestroyed() && deps.ordinary(wc) === true; } catch { return false; } };

  // The permission check for a session's handler: `origin` as Electron gives it (a trailing slash), details.requestingUrl.
  // Electron gives the WebHID / WebUSB / Web Serial checks no contents (wc is null), so for those the answer is about the
  // origin alone, and a tab the AI controls is refused where the contents are known: in the chooser (request() below).
  // When it is given, an ordinary tab is required here too.
  function check(wc, permission, origin, details) {
    return P.checkAllowed({ permission, origin: P.originOf(origin, details?.requestingUrl, details?.securityOrigin), ordinary: wc ? ordinary(wc) : true });
  }

  // `store`: the grants for this session (createGrantStore). `windowOf(wc)`: the window a tab lives in, when that is not
  // simply the one it is drawn in (a private window).
  function install(ses, { store, windowOf = null }) {
    const pending = new Set(); // { type, wc, devices: Map(id -> device), update() }

    ses.setDevicePermissionHandler((details) => {
      try { return P.deviceAllowed(store, details); } catch { return false; }
    });
    ses.setUSBProtectedClassesHandler((details) => details.protectedClasses); // Chromium's own list, nothing unprotected

    function request(type, event, { frame, wc, list }, callback) {
      event.preventDefault();
      let answered = false;
      let entry = null;
      const answer = (id) => {
        if (answered) return;
        answered = true;
        if (entry) pending.delete(entry);
        try { if (id) callback(id); else callback(); } catch { /* the page is gone */ }
      };
      // The asking frame's own origin (the first one that can be read: a frame that has navigated away throws), and
      // only if that is http(s): a Lumen page or a sandboxed frame is never offered the chooser.
      const asked = [() => frame?.origin, () => frame?.url, () => wc?.getURL?.()].map((read) => { try { return read(); } catch { return ''; } }).find((value) => typeof value === 'string' && value);
      const origin = P.originOf(asked);
      if (!ordinary(wc) || !origin) return answer('');
      const devices = new Map();
      const rows = () => [...devices.values()].map(({ device }) => P.describe(type, device, t('device.unknown')));
      for (const device of P.selectable(type, list)) devices.set(P.describe(type, device).id, { device });
      let host = origin;
      try { host = new URL(origin).host; } catch { /* keep the origin */ }
      const chooser = dialogs.chooseDevice({
        owner: wc,
        window: windowOf?.(wc) || null,
        message: t(`device.ask.${type}`, { host }),
        emptyText: t('device.none'),
        buttons: [t('dialog.cancel'), t('device.connect')],
        items: rows(),
      });
      entry = { type, wc, devices, refresh: () => chooser.update(rows()) };
      pending.add(entry);
      chooser.done.then(({ choice }) => {
        const picked = choice && devices.get(choice);
        if (!picked || P.isFido(type, picked.device)) return answer('');
        const identity = P.identityOf(type, picked.device);
        const name = P.describe(type, picked.device, '').name;
        // Remembered before the page is told: Electron asks the device handler (above) from then on.
        if (!identity || !store.grant(origin, identity, name)) return answer('');
        answer(choice);
      }, () => answer(''));
    }

    // A device plugged in or out while a chooser for this kind of device is open.
    function change(type, device, wc, add) {
      const id = P.describe(type, device).id;
      for (const entry of pending) {
        if (entry.type !== type || (wc && entry.wc !== wc)) continue;
        if (add) { if (P.selectable(type, [device]).length) entry.devices.set(id, { device }); } else entry.devices.delete(id);
        entry.refresh();
      }
    }
    const frameContents = (frame) => { try { return frame ? deps.webContentsFromFrame(frame) : null; } catch { return null; } };

    ses.on('select-hid-device', (event, details, callback) => request('hid', event, { frame: details.frame, wc: frameContents(details.frame), list: details.deviceList }, callback));
    ses.on('select-usb-device', (event, details, callback) => request('usb', event, { frame: details.frame, wc: frameContents(details.frame), list: details.deviceList }, callback));
    ses.on('select-serial-port', (event, portList, wc, callback) => request('serial', event, { frame: wc?.mainFrame, wc, list: portList }, callback));
    ses.on('hid-device-added', (_e, details) => change('hid', details.device, frameContents(details.frame), true));
    ses.on('hid-device-removed', (_e, details) => change('hid', details.device, frameContents(details.frame), false));
    ses.on('usb-device-added', (_e, device, wc) => change('usb', device, wc, true));
    ses.on('usb-device-removed', (_e, device, wc) => change('usb', device, wc, false));
    ses.on('serial-port-added', (_e, port, wc) => change('serial', port, wc, true));
    ses.on('serial-port-removed', (_e, port, wc) => change('serial', port, wc, false));

    // device.forget() (or port.forget()): the site no longer has it.
    const revoked = (type, device, origin) => { const identity = P.identityOf(type, device); const site = P.originOf(origin); if (identity && site) store.revoke(site, identity); };
    ses.on('hid-device-revoked', (_e, details) => revoked('hid', details.device, details.origin));
    ses.on('usb-device-revoked', (_e, details) => revoked('usb', details.device, details.origin));
    ses.on('serial-port-revoked', (_e, details) => revoked('serial', details.port, details.origin));

    return { pending: () => pending.size };
  }

  return { check, install, types: TYPES };
}

module.exports = { createDeviceChooser };
