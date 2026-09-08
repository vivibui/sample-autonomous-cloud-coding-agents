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
 * Generates a custom CDK bootstrap template that replaces AdministratorAccess
 * with ABCA least-privilege managed policies. The template supports per-compute-variant
 * selection via the ComputeTypes parameter.
 *
 * Usage: npx tsx scripts/generate-bootstrap-template.ts
 * Output: cdk/bootstrap/bootstrap-template.yaml
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

import {
  applicationPolicy,
  computeAgentcorePolicy,
  computeEcsPolicy,
  computeLambdaMicrovmPolicy,
  infrastructurePolicy,
  observabilityPolicy,
} from '../src/bootstrap/policies';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../src/bootstrap/version';

// --- Paths ---
// aws-cdk is hoisted to the workspace root node_modules; use require.resolve to find it
const awsCdkDir = join(require.resolve('aws-cdk/package.json'), '..');
const cdkBootstrapTemplatePath = join(
  awsCdkDir,
  'lib',
  'api',
  'bootstrap',
  'bootstrap-template.yaml',
);
const outputDir = join(__dirname, '..', 'bootstrap');
const outputPath = join(outputDir, 'bootstrap-template.yaml');

// --- Read and parse the default template ---
const rawTemplate = readFileSync(cdkBootstrapTemplatePath, 'utf-8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const template: any = yaml.load(rawTemplate);

// --- Step 1: Update BootstrapVariant default ---
template.Parameters.BootstrapVariant.Default = 'ABCA: Least-Privilege Bootstrap';

// --- Step 2: Add ComputeTypes parameter ---
template.Parameters.ComputeTypes = {
  Type: 'CommaDelimitedList',
  Default: 'agentcore',
  Description:
    'Comma-separated list of compute backends to enable. Valid values: agentcore, ecs, lambda-microvm.',
};

// --- Step 3: Add conditions ---
/**
 * "The joined ComputeTypes list contains `needle`" as a CloudFormation
 * condition. There is no `Fn::Contains`, so the trick is: split the joined list
 * on the needle and compare element 0 against the whole string — they differ
 * only if the needle was actually present. Extracted into a helper (it was
 * inline for ECS) so a third backend cannot introduce a subtly different
 * variant of the same expression.
 */
function includesComputeType(needle: string): Record<string, unknown> {
  const joined = { 'Fn::Join': ['', { Ref: 'ComputeTypes' }] };
  return {
    'Fn::Not': [
      {
        'Fn::Equals': [
          { 'Fn::Select': [0, { 'Fn::Split': [needle, joined] }] },
          joined,
        ],
      },
    ],
  };
}

template.Conditions.IncludeComputeEcs = includesComputeType('ecs');
// ADR-021: matched on the full `lambda-microvm` token, NOT a prefix — a bare
// `Fn::Split` on `lambda` would also fire for any future `lambda*` backend name.
template.Conditions.IncludeComputeLambdaMicrovms = includesComputeType('lambda-microvm');

// --- Step 4: Add managed policy resources ---
interface PolicyDef {
  logicalId: string;
  policyName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyFn: () => any;
  condition?: string;
}

const policyDefs: PolicyDef[] = [
  {
    logicalId: 'IaCRoleABCAInfrastructure',
    policyName: 'IaCRole-ABCA-Infrastructure',
    policyFn: infrastructurePolicy,
  },
  {
    logicalId: 'IaCRoleABCAApplication',
    policyName: 'IaCRole-ABCA-Application',
    policyFn: applicationPolicy,
  },
  {
    logicalId: 'IaCRoleABCAObservability',
    policyName: 'IaCRole-ABCA-Observability',
    policyFn: observabilityPolicy,
  },
  {
    logicalId: 'IaCRoleABCAComputeAgentcore',
    policyName: 'IaCRole-ABCA-Compute-Agentcore',
    policyFn: computeAgentcorePolicy,
  },
  {
    logicalId: 'IaCRoleABCAComputeEcs',
    policyName: 'IaCRole-ABCA-Compute-ECS',
    policyFn: computeEcsPolicy,
    condition: 'IncludeComputeEcs',
  },
  {
    logicalId: 'IaCRoleABCAComputeLambdaMicrovms',
    policyName: 'IaCRole-ABCA-Compute-LambdaMicrovms',
    policyFn: computeLambdaMicrovmPolicy,
    condition: 'IncludeComputeLambdaMicrovms',
  },
];

for (const { logicalId, policyName, policyFn, condition } of policyDefs) {
  const policyDoc = policyFn().toJSON();
  // Ensure Version is present in the policy document
  if (!policyDoc.Version) {
    policyDoc.Version = '2012-10-17';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resource: any = {
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: {
      ManagedPolicyName: {
        'Fn::Sub': `cdk-\${Qualifier}-${policyName}-\${AWS::AccountId}-\${AWS::Region}`,
      },
      PolicyDocument: policyDoc,
      Description: `ABCA Bootstrap: ${policyName} permissions for CloudFormation execution role`,
    },
  };

  if (condition) {
    resource.Condition = condition;
  }

  template.Resources[logicalId] = resource;
}

// --- Step 5: Modify CloudFormationExecutionRole ManagedPolicyArns ---
// Replace the conditional that falls back to AdministratorAccess with our inline policies.
// Keep the CloudFormationExecutionPolicies parameter override for flexibility.
const coreRefs = [
  { Ref: 'IaCRoleABCAInfrastructure' },
  { Ref: 'IaCRoleABCAApplication' },
  { Ref: 'IaCRoleABCAObservability' },
  { Ref: 'IaCRoleABCAComputeAgentcore' },
  { 'Fn::If': ['IncludeComputeEcs', { Ref: 'IaCRoleABCAComputeEcs' }, { Ref: 'AWS::NoValue' }] },
  {
    'Fn::If': [
      'IncludeComputeLambdaMicrovms',
      { Ref: 'IaCRoleABCAComputeLambdaMicrovms' },
      { Ref: 'AWS::NoValue' },
    ],
  },
];

template.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns = {
  'Fn::If': [
    'HasCloudFormationExecutionPolicies',
    { Ref: 'CloudFormationExecutionPolicies' },
    coreRefs,
  ],
};

// --- Step 6: Add outputs ---
template.Outputs.BootstrapPolicyVersion = {
  Description: 'The version of the ABCA bootstrap policy bundle',
  Value: BOOTSTRAP_VERSION,
};

template.Outputs.BootstrapPolicyHash = {
  Description: 'SHA-256 hash of the ABCA bootstrap policy bundle for drift detection',
  Value: computeBootstrapHash(),
};

template.Outputs.BootstrapPolicySet = {
  Description: 'Comma-separated list of active ABCA bootstrap policy names',
  Value: {
    'Fn::Join': [
      ',',
      [
        'Infrastructure',
        'Application',
        'Observability',
        'Compute-Agentcore',
        { 'Fn::If': ['IncludeComputeEcs', 'Compute-ECS', { Ref: 'AWS::NoValue' }] },
        {
          'Fn::If': [
            'IncludeComputeLambdaMicrovms',
            'Compute-LambdaMicrovms',
            { Ref: 'AWS::NoValue' },
          ],
        },
      ],
    ],
  },
};

// --- Step 7: Write output ---
mkdirSync(outputDir, { recursive: true });

/**
 * CloudFormation only accepts a template inline (`TemplateBody`) up to 51,200 bytes;
 * past that it must come from S3. `cdk bootstrap` cannot do that on a fresh account —
 * the bucket it would upload to is the thing bootstrap creates — so an oversized
 * template makes first-time bootstrap fail outright with `BootstrapStackRequired`
 * (#864). Keep a margin so a policy addition does not silently re-cross the line.
 */
const CFN_INLINE_TEMPLATE_LIMIT = 51_200;
const TEMPLATE_SIZE_BUDGET = 48_000;

/**
 * `flowLevel` switches collections to inline flow style below the given nesting
 * depth. At 6, IAM statement objects render one-per-line (`- {Action: …, Effect: …}`)
 * instead of exploding each key and every action string onto its own line. That is
 * the same YAML — verified by a round-trip equality test — for roughly 15 KB less,
 * which is what brings the template under the inline limit with headroom.
 */
const yamlOutput = yaml.dump(template, {
  lineWidth: 120,
  noRefs: true,
  quotingType: "'",
  forceQuotes: false,
  flowLevel: 6,
});

// Add a header comment
const header = [
  '# GENERATED FILE - DO NOT EDIT DIRECTLY',
  '# This template is generated by: npx tsx scripts/generate-bootstrap-template.ts',
  `# ABCA Bootstrap Policy Version: ${BOOTSTRAP_VERSION}`,
  `# ABCA Bootstrap Policy Hash: ${computeBootstrapHash()}`,
  '#',
  '# Based on the default CDK bootstrap template with the following modifications:',
  '#   - BootstrapVariant set to "ABCA: Least-Privilege Bootstrap"',
  '#   - ComputeTypes parameter added for compute-variant selection',
  '#   - IncludeComputeEcs / IncludeComputeLambdaMicrovms conditions added',
  '#   - 6 inline AWS::IAM::ManagedPolicy resources replace AdministratorAccess',
  '#   - CloudFormationExecutionRole references our least-privilege policies',
  '#   - BootstrapPolicyVersion, BootstrapPolicyHash, BootstrapPolicySet outputs added',
  '',
].join('\n');

const rendered = header + yamlOutput;

// Fail generation rather than emit a template that cannot bootstrap a fresh account.
// Catching this here — at the point the bytes are produced — is what stops the failure
// from being discovered later as an opaque CDK CLI error against a real account.
if (rendered.length > TEMPLATE_SIZE_BUDGET) {
  const overBudget = rendered.length - TEMPLATE_SIZE_BUDGET;
  const overHardLimit = rendered.length > CFN_INLINE_TEMPLATE_LIMIT;
  throw new Error(
    `Bootstrap template is ${rendered.length} bytes, over the ${TEMPLATE_SIZE_BUDGET}-byte budget by ${overBudget}`
    + ` (CloudFormation inline limit is ${CFN_INLINE_TEMPLATE_LIMIT}${overHardLimit ? ' — ALREADY EXCEEDED' : ''}).`
    + ' A template past the inline limit cannot bootstrap a fresh account at all (#864).'
    + ' Reduce policy statement count, consolidate overlapping statements, or scope more'
    + ' compute-variant policies behind a Condition.',
  );
}

writeFileSync(outputPath, rendered);

console.log(
  `Generated bootstrap template (v${BOOTSTRAP_VERSION}) -> ${outputPath}`
  + ` [${rendered.length} bytes, ${TEMPLATE_SIZE_BUDGET - rendered.length} under budget]`,
);
