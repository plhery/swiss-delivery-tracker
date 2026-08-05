import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'contracts', 'openapi.json');
const typesPath = path.join(root, 'src', 'generated', 'apiContract.ts');
const pythonPath = path.join(root, 'server', 'api_contract.py');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const schemas = contract.components?.schemas;
const carrierCapabilities = contract['x-carriers'];

if (contract.openapi !== '3.1.0' || !schemas || !carrierCapabilities) {
  throw new Error(
    'contracts/openapi.json must be an OpenAPI 3.1 document with schemas and x-carriers',
  );
}

function resolvePointer(reference) {
  if (!reference.startsWith('#/')) throw new Error(`Only local references are supported: ${reference}`);
  let current = contract;
  for (const rawSegment of reference.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    current = current?.[segment];
    if (current === undefined) throw new Error(`Unresolved contract reference: ${reference}`);
  }
  return current;
}

function validateReferences(value) {
  if (Array.isArray(value)) {
    value.forEach(validateReferences);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') resolvePointer(value.$ref);
  Object.values(value).forEach(validateReferences);
}

function validateOperations() {
  const operationIds = new Set();
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  for (const [route, pathItem] of Object.entries(contract.paths ?? {})) {
    if (!route.startsWith('/')) throw new Error(`Invalid API path: ${route}`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      if (!operation.operationId || operationIds.has(operation.operationId)) {
        throw new Error(`Missing or duplicate operationId for ${method.toUpperCase()} ${route}`);
      }
      if (!operation.responses || Object.keys(operation.responses).length === 0) {
        throw new Error(`Missing responses for ${method.toUpperCase()} ${route}`);
      }
      operationIds.add(operation.operationId);
    }
  }
}

validateReferences(contract);
validateOperations();

const carrierIds = schemas.CarrierId?.enum;
if (!Array.isArray(carrierIds)) throw new Error('CarrierId must define an enum');
const configuredCarrierIds = Object.keys(carrierCapabilities);
if (
  carrierIds.length !== configuredCarrierIds.length
  || carrierIds.some((carrierId) => !Object.hasOwn(carrierCapabilities, carrierId))
) {
  throw new Error('x-carriers must define every CarrierId exactly once');
}

const carrierInputValidators = {
  trackingUrl: new Set(['planzerSharedUrl', 'dachserCapabilityUrl']),
  dpdPostcode: new Set(['swissPostcode']),
};
for (const [carrierId, definition] of Object.entries(carrierCapabilities)) {
  const tracking = definition?.tracking;
  if (
    typeof definition?.displayName !== 'string'
    || typeof definition?.color !== 'string'
    || typeof definition?.selectable !== 'boolean'
    || typeof definition?.timezone !== 'string'
    || !tracking
    || !['automatic', 'link-only'].includes(tracking.mode)
  ) {
    throw new Error(`x-carriers.${carrierId} has invalid capability metadata`);
  }
  if (
    (tracking.mode === 'automatic' && typeof tracking.adapter !== 'string')
    || (tracking.mode === 'link-only' && tracking.adapter !== null)
    || (tracking.adapter === 'upstream' && typeof tracking.upstreamName !== 'string')
  ) {
    throw new Error(`x-carriers.${carrierId} has an invalid tracking adapter`);
  }
  if (tracking.mode === 'automatic') {
    let canaryUrl;
    try {
      canaryUrl = new URL(definition.canaryUrl);
    } catch {
      throw new Error(`x-carriers.${carrierId} must define a valid canaryUrl`);
    }
    if (
      canaryUrl.protocol !== 'https:'
      || canaryUrl.username
      || canaryUrl.password
      || canaryUrl.search
      || canaryUrl.hash
    ) {
      throw new Error(`x-carriers.${carrierId} must define a public HTTPS canaryUrl`);
    }
  }
  const fields = new Set();
  for (const requirement of tracking.requirements ?? []) {
    const validators = carrierInputValidators[requirement.field];
    if (
      !validators
      || fields.has(requirement.field)
      || !validators.has(requirement.validator)
      || !['text', 'url'].includes(requirement.type)
      || typeof requirement.label !== 'string'
    ) {
      throw new Error(`x-carriers.${carrierId} has an invalid input requirement`);
    }
    fields.add(requirement.field);
    if (requirement.whenTrackingNumber) new RegExp(requirement.whenTrackingNumber);
    if (requirement.pattern) new RegExp(requirement.pattern);
  }
  for (const rule of definition.detectionRules ?? []) {
    new RegExp(rule.pattern);
    if (!['high', 'low'].includes(rule.confidence) || ![undefined, 's10'].includes(rule.checksum)) {
      throw new Error(`x-carriers.${carrierId} has an invalid detection rule`);
    }
  }
}

const enumConstants = {
  CarrierId: 'CARRIER_IDS',
  Stage: 'STAGES',
  SyncStatus: 'SYNC_STATUSES',
};

function refName(ref) {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported schema reference: ${ref}`);
  return `Api${ref.slice(prefix.length)}`;
}

function typeScriptType(schema) {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.anyOf) return schema.anyOf.map(typeScriptType).join(' | ');
  if (schema.oneOf) return schema.oneOf.map(typeScriptType).join(' | ');
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((type) => typeScriptType({ ...schema, type }))
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(' | ');
  }
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `Array<${typeScriptType(schema.items ?? {})}>`;
    case 'object': {
      const entries = Object.entries(schema.properties ?? {});
      if (entries.length === 0) return 'Record<string, unknown>';
      const required = new Set(schema.required ?? []);
      const fields = entries.map(
        ([name, property]) =>
          `  ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${typeScriptType(property)};`,
      );
      return `{\n${fields.join('\n')}\n}`;
    }
    default:
      return 'unknown';
  }
}

function generatedTypeScript() {
  const lines = [
    '/* This file is generated by scripts/generate-api-contract.mjs. Do not edit. */',
    '',
    `export const CARRIER_CAPABILITIES = ${JSON.stringify(carrierCapabilities, null, 2)} as const;`,
    '',
  ];
  for (const [name, schema] of Object.entries(schemas)) {
    const constant = enumConstants[name];
    if (constant) {
      lines.push(`export const ${constant} = ${JSON.stringify(schema.enum, null, 2)} as const;`);
      lines.push(`export type Api${name} = (typeof ${constant})[number];`, '');
      continue;
    }
    if (schema.type === 'object' && schema.properties) {
      const required = new Set(schema.required ?? []);
      lines.push(`export interface Api${name} {`);
      for (const [propertyName, property] of Object.entries(schema.properties)) {
        lines.push(
          `  ${JSON.stringify(propertyName)}${required.has(propertyName) ? '' : '?'}: ${typeScriptType(property)};`,
        );
      }
      lines.push('}', '');
      continue;
    }
    lines.push(`export type Api${name} = ${typeScriptType(schema)};`, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

function pythonLiteral(value, indent = 0) {
  const padding = ' '.repeat(indent);
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '()';
    const rows = value.map((item) => `${' '.repeat(indent + 4)}${pythonLiteral(item, indent + 4)},`);
    return `(\n${rows.join('\n')}\n${padding})`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const rows = entries.map(
      ([key, item]) => `${' '.repeat(indent + 4)}${JSON.stringify(key)}: ${pythonLiteral(item, indent + 4)},`,
    );
    return `{\n${rows.join('\n')}\n${padding}}`;
  }
  throw new Error(`Unsupported Python literal: ${typeof value}`);
}

function generatedPython() {
  const lines = [
    '"""Generated from contracts/openapi.json. Do not edit."""',
    '',
    `CARRIER_CAPABILITIES = ${pythonLiteral(carrierCapabilities)}`,
    '',
  ];
  for (const [name, constant] of Object.entries(enumConstants)) {
    const values = schemas[name]?.enum;
    if (!Array.isArray(values)) throw new Error(`${name} must define an enum`);
    lines.push(`${constant} = frozenset(`, '    (');
    for (const value of values) lines.push(`        ${JSON.stringify(value)},`);
    lines.push('    )', ')', '');
  }
  return `${lines.join('\n').trim()}\n`;
}

const outputs = [
  [typesPath, generatedTypeScript()],
  [pythonPath, generatedPython()],
];

if (process.argv.includes('--check')) {
  const stale = [];
  for (const [target, expected] of outputs) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== expected) stale.push(path.relative(root, target));
  }
  if (stale.length > 0) {
    throw new Error(
      `Generated API contract files are stale: ${stale.join(', ')}. Run npm run contract:generate.`,
    );
  }
  console.log('Generated API contract files are current.');
} else {
  for (const [target, contents] of outputs) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    console.log(`Wrote ${path.relative(root, target)}`);
  }
}
