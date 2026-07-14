const credentialKeys = ["connection", "serverUrl", "accessToken"];

function purgeCredentials() {
  try {
    return Promise.resolve(
      chrome.storage.local.remove(credentialKeys)
    ).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

try {
  Promise.resolve(
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ).catch(purgeCredentials);
} catch {
  purgeCredentials();
}
