chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
}).catch(() => {
  // Never leave known credential keys exposed if trusted-only access cannot
  // be established. The popup independently fails closed and reports it.
  return chrome.storage.local.remove([
    "connection",
    "serverUrl",
    "accessToken",
  ]).catch(() => {
    // The background never reads or uses credentials after either failure.
  });
});
