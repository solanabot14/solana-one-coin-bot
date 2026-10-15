function liquidityLockAllowsEntry(lock, minimumLockedPercent, allowUnknown = false) {
  const rawPercent = lock?.lockedPercent;
  if (rawPercent === null || rawPercent === undefined) {
    return allowUnknown && lock?.reason === "LOCK_STATUS_UNAVAILABLE";
  }
  const lockedPercent = Number(rawPercent);
  return Number.isFinite(lockedPercent) && lockedPercent >= minimumLockedPercent;
}

module.exports = { liquidityLockAllowsEntry };
