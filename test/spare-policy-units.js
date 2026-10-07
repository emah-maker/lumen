// The spare new-tab page's policy (src/features/spare-policy.js): one spare, only after start-up, dropped under memory pressure.
const sp = require('../src/features/spare-policy');

module.exports = async function sparePolicyUnits(check) {
  const GB = 1024 ** 3;
  const roomy = { totalBytes: 16 * GB, freeBytes: 8 * GB, lumenBytes: 2 * GB };
  check('spare: roomy memory is not tight', sp.memoryTight(roomy) === false, '');
  check('spare: under 10% free is tight', sp.memoryTight({ totalBytes: 16 * GB, freeBytes: 1.5 * GB }) === true, '');
  check('spare: under 1 GB free is tight even when it is over 10%', sp.memoryTight({ totalBytes: 8 * GB, freeBytes: 0.9 * GB }) === true, '');
  check('spare: Lumen holding over 6 GB is tight', sp.memoryTight({ ...roomy, lumenBytes: 7 * GB }) === true, '');
  check('spare: the macOS pressure level is tight', sp.memoryTight({ pressure: true }) === true, '');
  check('spare: unknown memory limits nothing', sp.memoryTight({}) === false && sp.memoryTight() === false, '');
  check('spare: none yet, start-up over, memory fine -> make', sp.spareAction({ hasSpare: false, firstTabDone: true, memory: roomy }) === 'make', '');
  check('spare: none yet during start-up (session restore) -> wait', sp.spareAction({ hasSpare: false, firstTabDone: false, memory: roomy }) === 'wait', '');
  check('spare: none yet, memory tight -> wait', sp.spareAction({ hasSpare: false, firstTabDone: true, memory: { pressure: true } }) === 'wait', '');
  check('spare: one exists, memory fine -> keep (never a second)', sp.spareAction({ hasSpare: true, firstTabDone: true, memory: roomy }) === 'keep', '');
  check('spare: one exists, memory tight -> drop', sp.spareAction({ hasSpare: true, firstTabDone: true, memory: { totalBytes: 8 * GB, freeBytes: 0.5 * GB } }) === 'drop', '');
  check('spare: no arguments is a wait', sp.spareAction() === 'wait', '');
};
