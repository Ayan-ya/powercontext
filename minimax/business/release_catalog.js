export function filterReleases(releases, filters = {}) {
  if (!Array.isArray(releases)) throw new TypeError("releases must be an array");

  const { owner, status } = filters;
  const requestedStatuses = (Array.isArray(status) ? status : [status])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());

  return releases.filter((release) => {
    if (owner !== undefined && release.owner !== owner) return false;
    if (requestedStatuses.length === 0) return true;
    return requestedStatuses.includes(String(release.status).trim().toLowerCase());
  });
}
