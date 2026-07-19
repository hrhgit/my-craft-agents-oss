const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const fs = require('fs');
const path = require('path');

function isSigningRequired() {
  return TRUE_VALUES.has(String(process.env.MORTISE_REQUIRE_CODE_SIGNING ?? '').trim().toLowerCase());
}

module.exports = async function beforePack(context) {
  const markerPath = path.join(context.packager.projectDir, 'dist', '.developer-host-build.json');
  if (!fs.existsSync(markerPath)) {
    throw new Error('Electron build identity marker is missing; run the matching Mortise build entry before packaging.');
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const isDeveloperHostPackage = context.packager.appInfo.productName === 'Mortise Developer Host';
  if (marker.developerHostBuild !== isDeveloperHostPackage) {
    throw new Error('Electron build identity does not match the selected package configuration.');
  }
  if (isDeveloperHostPackage && marker.uiValidationBuild !== true) {
    throw new Error('Mortise Developer Host requires a UI validation build.');
  }
  if (!isDeveloperHostPackage && marker.uiValidationBuild !== false) {
    throw new Error('The normal Mortise package must not contain the UI validation runtime.');
  }

  if (context.electronPlatformName !== 'win32') return;

  const hasCertificate = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
  if (isSigningRequired() && !hasCertificate) {
    throw new Error(
      'MORTISE_REQUIRE_CODE_SIGNING=1 requires CSC_LINK or WIN_CSC_LINK for Windows packaging.',
    );
  }
  if (!hasCertificate) {
    console.warn('Windows package will be unsigned (set MORTISE_REQUIRE_CODE_SIGNING=1 in release jobs).');
  }
};

module.exports.isSigningRequired = isSigningRequired;
