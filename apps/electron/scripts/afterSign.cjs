const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { isSigningRequired } = require('./beforePack.cjs');

function windowsSignatureStatus(executable) {
  const escapedPath = executable.replace(/'/g, "''");
  const errors = [];
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const result = spawnSync(shell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; (Get-AuthenticodeSignature -LiteralPath '${escapedPath}').Status.ToString()`,
    ], { encoding: 'utf8' });
    const status = result.stdout.trim();
    if (result.status === 0 && status) return status;
    errors.push(`${shell}: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`);
  }

  try {
    const moduleEntry = require.resolve('@electron/windows-sign');
    const signtool = path.join(path.dirname(moduleEntry), '..', 'vendor', 'signtool.exe');
    if (fs.existsSync(signtool)) {
      const result = spawnSync(signtool, ['verify', '/pa', executable], { encoding: 'utf8' });
      return result.status === 0 ? 'Valid' : 'NotSignedOrInvalid';
    }
  } catch (error) {
    errors.push(`signtool: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new Error(`Could not inspect Windows signature for ${executable}: ${errors.join('; ')}`);
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return;

  const executable = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  let status;
  try {
    status = windowsSignatureStatus(executable);
  } catch (error) {
    if (isSigningRequired()) throw error;
    console.warn(error instanceof Error ? error.message : String(error));
    return;
  }
  if (status === 'Valid') {
    console.log(`Windows Authenticode signature verified: ${executable}`);
    return;
  }
  if (isSigningRequired()) {
    throw new Error(`Windows executable is not validly signed (${status}): ${executable}`);
  }
  console.warn(`Windows executable is unsigned (${status}): ${executable}`);
};

module.exports.windowsSignatureStatus = windowsSignatureStatus;
