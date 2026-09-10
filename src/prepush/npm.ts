/** CLI precedence is reapplied to EVERY npm invocation, even after candidate
 * code changes .npmrc. Userconfig alone does not exclude project configuration.
 */
export function npmArguments(install = false): string[] {
  return [
    "--prefix=/work",
    "--global=false",
    "--userconfig=/dev/null",
    "--globalconfig=/etc/wakewire-empty-global.npmrc",
    "--script-shell=/bin/sh",
    "--node-options=",
    "--workspaces=false",
    "--include-workspace-root=true",
    "--if-present=false",
    `--ignore-scripts=${install}`,
    "--dry-run=false",
  ];
}

// Every token is trusted constant data, not a candidate-provided shell fragment.
export const installCommand = `npm ${npmArguments(true).join(" ")} ci --no-audit --no-fund`;
export const verificationCommand = ["test", "run build", "run verify:push"]
  .map((operation) => `npm ${npmArguments().join(" ")} ${operation}`)
  .join(" && ");
