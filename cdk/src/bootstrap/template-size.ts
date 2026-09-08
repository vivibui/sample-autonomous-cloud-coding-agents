/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * How large the bootstrap template is *as CloudFormation receives it* (#864).
 *
 * The on-disk size of `bootstrap/bootstrap-template.yaml` is not that quantity and
 * cannot stand in for it. `cdk bootstrap --template <file>` parses the file and
 * discards its formatting, then re-serialises the parsed object with the CLI's own
 * YAML writer before deciding whether the result fits inline:
 *
 * ```js
 * // aws-cdk/lib/index.js — makeBodyParameter()
 * const templateJson = toYAML(overrideTemplate ?? stack.template);
 * if (templateJson.length <= LARGE_TEMPLATE_SIZE_KB * 1024) return { TemplateBody: templateJson };
 * const toolkitInfo = await resources.lookupToolkit();   // ← needs a bootstrap bucket
 * ```
 *
 * Past the limit the CLI must stage the template in S3, which it cannot do while
 * bootstrapping a fresh account — that bucket is one of the resources bootstrap
 * creates. The result is `BootstrapStackRequired`, with no way through
 * `cdk bootstrap` at all, `--force` included.
 *
 * So both the generator's guard and the artifact's regression test measure
 * {@link cloudFormationBodySize}, never bytes on disk.
 */

import { execFileSync } from 'node:child_process';

/**
 * `LARGE_TEMPLATE_SIZE_KB * 1024` in the CDK CLI — the ceiling above which a
 * template must come from S3 rather than inline `TemplateBody`.
 */
const LARGE_TEMPLATE_SIZE_KB = 50;
export const CFN_INLINE_TEMPLATE_LIMIT = LARGE_TEMPLATE_SIZE_KB * 1024;

/**
 * Where the generator fails, deliberately below {@link CFN_INLINE_TEMPLATE_LIMIT}.
 *
 * The margin is the point: a policy addition should fail in the generator, where the
 * content is produced and the author can act on it, rather than surfacing later as an
 * opaque CDK CLI error against somebody's fresh account.
 */
export const TEMPLATE_SIZE_BUDGET = 49_152;

/** Ceiling for the rendered template captured from the CLI, well clear of any plausible
 *  template size so a growing artifact fails the budget check rather than truncating
 *  into a falsely-passing measurement. */
const STDOUT_BUFFER_MIB = 32;
const STDOUT_BUFFER_BYTES = STDOUT_BUFFER_MIB * 1024 * 1024;

/**
 * Ask the CDK CLI itself how large the body will be.
 *
 * `cdk bootstrap --show-template` runs the same `toYAML` path as the real bootstrap, so
 * this measures the CLI's own output rather than a local reimplementation of it. That
 * matters more than it might seem: the CLI serialises with `yaml@1` and a patched fold
 * width, which it bundles internally and does not export. Mirroring that would mean
 * taking a direct dependency on `yaml` — currently present only as a transitive
 * `resolutions` pin — and would silently drift the day the CLI changes writer or
 * options. Shelling out to the tool that makes the decision cannot drift.
 *
 * Needs no AWS credentials and no network: `--show-template` only renders.
 */
export function cloudFormationBodySize(templatePath: string, cwd: string): number {
  const stdout = execFileSync(
    'npx',
    ['cdk', 'bootstrap', '--show-template', '--template', templatePath],
    {
      cwd,
      encoding: 'utf-8',
      maxBuffer: STDOUT_BUFFER_BYTES,
      // `--show-template` writes progress to stderr; keep it off the test output.
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );

  // The CLI prints the body followed by a newline. The gate is on the body, so drop
  // exactly one trailing newline if present rather than counting the console artefact.
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;

  // `String.length` (UTF-16 code units), matching the CLI's own
  // `templateJson.length <= LARGE_TEMPLATE_SIZE_KB * 1024`. Not `Buffer.byteLength`:
  // code units are what the gate compares, so counting UTF-8 bytes would diverge from
  // the real decision the moment a non-ASCII character entered a policy.
  return body.length;
}
