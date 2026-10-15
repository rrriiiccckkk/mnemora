/** Match supported native-SQLite patch lines without pinning a Node major. */
export function supportsNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major === 24 && minor >= 15 || major === 25 && minor >= 9 || major >= 26;
}
