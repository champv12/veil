export function thirdPartyNotices(lock) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") throw new Error("Notices require package-lock v3");
  const packages = new Map();
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (!packagePath.includes("node_modules/") || entry.link) continue;
    const name = packageName(packagePath);
    if (typeof entry.version !== "string" || !entry.version) throw new Error(`Locked third-party package has no version: ${packagePath}`);
    if (typeof entry.license !== "string" || !entry.license) throw new Error(`Locked third-party package has no license metadata: ${name}@${entry.version}`);
    packages.set(`${name}@${entry.version}`, { name, version: entry.version, license: entry.license });
  }
  const rows = [...packages.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  return [
    "# Third-party notices",
    "",
    "This file is generated from `package-lock.json`. Every locked third-party package must declare license metadata before the public export can pass.",
    "",
    "| Package | Version | License |",
    "| --- | --- | --- |",
    ...rows.map((entry) => `| ${escapeCell(entry.name)} | ${escapeCell(entry.version)} | ${escapeCell(entry.license)} |`),
    "",
    "The applicable license texts and notices remain available in each installed package and its upstream project.",
    "",
  ].join("\n");
}

function packageName(packagePath) {
  const marker = "node_modules/";
  return packagePath.slice(packagePath.lastIndexOf(marker) + marker.length);
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
