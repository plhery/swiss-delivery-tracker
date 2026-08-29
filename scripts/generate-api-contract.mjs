import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'contracts', 'openapi.json');
const typesPath = path.join(root, 'src', 'generated', 'apiContract.ts');
const swiftPath = path.join(root, 'ios', 'SwissDeliveryTracker', 'GeneratedAPIContract.swift');
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
  dpdPostcode: new Set(['swissPostcode', 'francePostcode']),
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

const swiftSchemaNames = {
  CarrierId: 'CarrierID',
  Stage: 'TrackingStage',
  TrackingEventRow: 'TrackingEvent',
  PackageRow: 'Parcel',
  OkResponse: 'OKResponse',
};

const swiftInlineNames = {
  'AccountExportResponse.account': 'AccountExportAccount',
  'PackageRow.carrier_data': 'CarrierData',
  'NativePushDeviceRequest.environment': 'NativePushEnvironment',
  'NativePushDeviceRequest.locale': 'NativePushLocale',
};

const swiftEnumCaseNames = {
  'CarrierId.intl-post': 'internationalPost',
  'CarrierId.spring-gds': 'springGDS',
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

function upperFirst(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function lowerCamelIdentifier(value) {
  const words = value.split(/[-_]/).filter(Boolean);
  if (words.length === 0) throw new Error(`Cannot generate a Swift identifier for ${value}`);
  return words[0] + words.slice(1).map(upperFirst).join('');
}

function swiftPropertyName(value) {
  return lowerCamelIdentifier(value)
    .replace(/Ids$/, 'IDs')
    .replace(/Id$/, 'ID')
    .replace(/Urls$/, 'URLs')
    .replace(/Url$/, 'URL');
}

function swiftTypeName(schemaName) {
  return swiftSchemaNames[schemaName] ?? schemaName;
}

function swiftReferenceName(reference) {
  const prefix = '#/components/schemas/';
  if (!reference.startsWith(prefix)) {
    throw new Error(`Unsupported Swift schema reference: ${reference}`);
  }
  return swiftTypeName(reference.slice(prefix.length));
}

function swiftEnumCase(schemaName, value) {
  return swiftEnumCaseNames[`${schemaName}.${value}`] ?? swiftPropertyName(value);
}

function schemaAllowsNull(schema) {
  if (schema?.type === 'null') return true;
  if (Array.isArray(schema?.type) && schema.type.includes('null')) return true;
  return [...(schema?.anyOf ?? []), ...(schema?.oneOf ?? [])].some(schemaAllowsNull);
}

function schemaWithoutNull(schema) {
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== 'null');
    if (types.length !== 1) throw new Error(`Unsupported Swift type union: ${JSON.stringify(schema.type)}`);
    return { ...schema, type: types[0] };
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (schema[key]) {
      const alternatives = schema[key].filter((value) => !schemaAllowsNull(value));
      if (alternatives.length !== 1) {
        throw new Error(`Unsupported Swift ${key} union: ${JSON.stringify(schema[key])}`);
      }
      return alternatives[0];
    }
  }
  return schema;
}

const swiftInlineSchemas = new Map();

function swiftInlineTypeName(parentSchemaName, propertyName) {
  return swiftInlineNames[`${parentSchemaName}.${propertyName}`]
    ?? `${swiftTypeName(parentSchemaName)}${upperFirst(swiftPropertyName(propertyName))}`;
}

function registerSwiftInlineSchema(parentSchemaName, propertyName, schema) {
  const name = swiftInlineTypeName(parentSchemaName, propertyName);
  const existing = swiftInlineSchemas.get(name);
  if (existing && JSON.stringify(existing.schema) !== JSON.stringify(schema)) {
    throw new Error(`Conflicting inline Swift schema name: ${name}`);
  }
  swiftInlineSchemas.set(name, { name, schema, schemaName: `${parentSchemaName}.${propertyName}` });
  return name;
}

function swiftBaseType(schema, parentSchemaName, propertyName) {
  const value = schemaWithoutNull(schema);
  if (value.$ref) return swiftReferenceName(value.$ref);
  if (value.enum) return registerSwiftInlineSchema(parentSchemaName, propertyName, value);
  switch (value.type) {
    case 'string':
      return value.format === 'uuid' ? 'UUID' : 'String';
    case 'integer':
      return 'Int';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Bool';
    case 'array':
      return `[${swiftBaseType(value.items ?? {}, parentSchemaName, `${propertyName}Item`)}]`;
    case 'object':
      if (value.properties) return registerSwiftInlineSchema(parentSchemaName, propertyName, value);
      throw new Error(`Object dictionaries are not supported by the Swift generator: ${parentSchemaName}.${propertyName}`);
    default:
      throw new Error(`Unsupported Swift schema at ${parentSchemaName}.${propertyName}: ${JSON.stringify(value)}`);
  }
}

function swiftProperty(schemaName, propertyName, schema, required) {
  const specialEmptyArray = schemaName === 'PackageRow' && propertyName === 'tracking_events';
  return {
    jsonName: propertyName,
    name: swiftPropertyName(propertyName),
    type: swiftBaseType(schema, schemaName, propertyName),
    optional: !specialEmptyArray && (!required || schemaAllowsNull(schema)),
    specialEmptyArray,
  };
}

function swiftCodingKey(property) {
  const decodedName = lowerCamelIdentifier(property.jsonName);
  return property.name === decodedName
    ? `        case ${property.name}`
    : `        case ${property.name} = ${JSON.stringify(decodedName)}`;
}

function generatedSwiftEnum(schemaName, swiftName, schema) {
  const lines = [
    `enum ${swiftName}: String, Codable, CaseIterable, Hashable, Sendable, Identifiable {`,
  ];
  for (const value of schema.enum) {
    const caseName = swiftEnumCase(schemaName, value);
    lines.push(caseName === value ? `    case ${caseName}` : `    case ${caseName} = ${JSON.stringify(value)}`);
  }
  lines.push('', '    var id: String { rawValue }', '}');
  return lines;
}

function generatedSwiftStruct(schemaName, swiftName, schema) {
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {}).map(([name, value]) =>
    swiftProperty(schemaName, name, value, required.has(name)));
  const conformances = ['Codable', 'Equatable', 'Hashable', 'Sendable'];
  if (properties.some((property) => property.name === 'id')) conformances.push('Identifiable');
  const lines = [`struct ${swiftName}: ${conformances.join(', ')} {`];
  for (const property of properties) {
    const defaultValue = property.specialEmptyArray ? ' = []' : property.optional ? ' = nil' : '';
    lines.push(`    var ${property.name}: ${property.type}${property.optional ? '?' : ''}${defaultValue}`);
  }
  if (properties.some((property) => property.name !== lowerCamelIdentifier(property.jsonName))) {
    lines.push('', '    private enum CodingKeys: String, CodingKey {');
    properties.forEach((property) => lines.push(swiftCodingKey(property)));
    lines.push('    }');
  }
  lines.push('}');
  return { lines, properties };
}

function generatedParcelDecoder(properties) {
  const lines = [
    'extension Parcel {',
    '    init(from decoder: Decoder) throws {',
    '        let values = try decoder.container(keyedBy: CodingKeys.self)',
  ];
  for (const property of properties) {
    if (property.specialEmptyArray) {
      lines.push(
        `        ${property.name} = try values.decodeIfPresent(${property.type}.self, forKey: .${property.name}) ?? []`,
      );
    } else if (property.optional) {
      lines.push(
        `        ${property.name} = try values.decodeIfPresent(${property.type}.self, forKey: .${property.name})`,
      );
    } else {
      lines.push(`        ${property.name} = try values.decode(${property.type}.self, forKey: .${property.name})`);
    }
  }
  lines.push('    }', '}');
  return lines;
}

function generatedSwift() {
  swiftInlineSchemas.clear();
  const lines = [
    '// This file is generated by scripts/generate-api-contract.mjs. Do not edit.',
    '',
    'import Foundation',
    '',
  ];
  let parcelProperties = null;
  for (const [schemaName, schema] of Object.entries(schemas)) {
    const swiftName = swiftTypeName(schemaName);
    if (schema.enum) {
      lines.push(...generatedSwiftEnum(schemaName, swiftName, schema), '');
    } else if (schema.type === 'object' && schema.properties) {
      const generated = generatedSwiftStruct(schemaName, swiftName, schema);
      lines.push(...generated.lines, '');
      if (schemaName === 'PackageRow') parcelProperties = generated.properties;
    } else {
      throw new Error(`Unsupported top-level Swift schema: ${schemaName}`);
    }
  }
  for (const { name, schema, schemaName } of swiftInlineSchemas.values()) {
    if (schema.enum) {
      lines.push(...generatedSwiftEnum(schemaName, name, schema), '');
    } else {
      lines.push(...generatedSwiftStruct(schemaName, name, schema).lines, '');
    }
  }
  if (!parcelProperties) throw new Error('PackageRow is required to generate the native Parcel model');
  lines.push(...generatedParcelDecoder(parcelProperties), '');
  return `${lines.join('\n').trim()}\n`;
}

const outputs = [
  [typesPath, generatedTypeScript()],
  [swiftPath, generatedSwift()],
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
