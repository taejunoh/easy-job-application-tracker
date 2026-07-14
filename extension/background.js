chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
}).catch(() => {
  // The popup independently fails closed if trusted storage is unavailable.
});
