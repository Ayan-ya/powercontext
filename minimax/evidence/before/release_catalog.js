export function filterReleases(releases, filters = {}) {
  if (!Array.isArray(releases)) throw new TypeError("releases must be an array");

  const { owner, status } = filters;
  return releases.filter((release) => {
    if (owner !== undefined && release.owner !== owner) return false;
    if (
      typeof status === "string" &&
      status.trim() !== "" &&
      release.status !== status
    ) {
      return false;
    }
    return true;
  });
}
