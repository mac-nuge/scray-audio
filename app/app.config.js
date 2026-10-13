// The IPA's version is 1.0.<GitHub Actions run number> (IPA_BUILD_NUMBER), so SideStore sees each build as an
// update. The page itself carries its own version (VERSION at the repo root, shown in the app's web layer).
const buildNumber = String(process.env.IPA_BUILD_NUMBER || '1');

module.exports = ({ config }) => ({
  ...config,
  version: `1.0.${buildNumber}`,
  ios: { ...config.ios, buildNumber },
});
