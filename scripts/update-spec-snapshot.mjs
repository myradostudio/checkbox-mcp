// Refreshes spec/checkbox-api.snapshot.json from the official Checkbox OpenAPI document.
//
// The snapshot holds only what the tests need to check our requests: for every
// operation listed in src/endpoints.ts its parameters, request body schema,
// security flag and response content types, plus the component schemas those
// refer to. Descriptions and titles are dropped.
//
// Usage:
//   npm run spec:update                      download the current document
//   npm run spec:update -- --from file.json  use a local copy instead
//
// After a refresh run `npm test`: a failure means the API changed under a tool.

import { readFile, writeFile } from 'node:fs/promises';

import { ENDPOINTS } from '../dist/endpoints.js';

const SOURCE_URL = 'https://api.checkbox.ua/api/openapi.json';
const SNAPSHOT_FILE = new URL('../spec/checkbox-api.snapshot.json', import.meta.url);

/** JSON Schema keywords worth keeping; everything else (titles, descriptions, examples) is dropped. */
const SCHEMA_KEYWORDS = new Set([
  '$ref',
  'type',
  'format',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'allOf',
  'oneOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'default',
]);

async function loadDocument() {
  const fromIndex = process.argv.indexOf('--from');
  if (fromIndex !== -1) {
    const file = process.argv[fromIndex + 1];
    if (!file) throw new Error('--from needs a file path');
    return JSON.parse(await readFile(file, 'utf8'));
  }
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GET ${SOURCE_URL} answered HTTP ${response.status}`);
  return response.json();
}

function reduceSchema(schema) {
  if (Array.isArray(schema)) return schema.map(reduceSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const reduced = {};
  for (const key of Object.keys(schema).sort()) {
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    const value = schema[key];
    if (key === 'properties') {
      reduced.properties = Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((name) => [name, reduceSchema(value[name])]),
      );
    } else if (key === 'items' || key === 'anyOf' || key === 'allOf' || key === 'oneOf') {
      reduced[key] = reduceSchema(value);
    } else {
      reduced[key] = value;
    }
  }
  return reduced;
}

function collectRefs(value, into) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') into.add(item.split('/').pop());
      else collectRefs(item, into);
    }
  }
}

function reduceOperation(document, operation) {
  const parameters = (operation.parameters ?? [])
    .map((parameter) =>
      parameter.$ref ? document.components.parameters[parameter.$ref.split('/').pop()] : parameter,
    )
    .map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required === true,
      schema: reduceSchema(parameter.schema ?? {}),
    }))
    .sort((a, b) => `${a.in} ${a.name}`.localeCompare(`${b.in} ${b.name}`));

  const reduced = {
    security: Array.isArray(operation.security) && operation.security.length > 0,
    parameters,
    responseTypes: [
      ...new Set(
        Object.entries(operation.responses ?? {})
          .filter(([status]) => status.startsWith('2'))
          .flatMap(([, response]) => Object.keys(response.content ?? {})),
      ),
    ].sort(),
  };

  const body = operation.requestBody?.content?.['application/json'];
  if (body) {
    reduced.requestBody = { required: operation.requestBody.required === true, schema: reduceSchema(body.schema) };
  }
  return reduced;
}

const document = await loadDocument();

const operations = {};
for (const endpoint of Object.values(ENDPOINTS)) {
  const operation = document.paths?.[endpoint.path]?.[endpoint.method.toLowerCase()];
  if (!operation) {
    throw new Error(`${endpoint.method} ${endpoint.path} is not in the OpenAPI document any more`);
  }
  operations[`${endpoint.method} ${endpoint.path}`] = reduceOperation(document, operation);
}

// Transitive closure of the component schemas the kept operations refer to.
const schemas = {};
const pending = new Set();
collectRefs(operations, pending);
while (pending.size > 0) {
  const [name] = pending;
  pending.delete(name);
  if (name in schemas) continue;
  const schema = document.components?.schemas?.[name];
  if (!schema) throw new Error(`Schema ${name} is referenced but not defined`);
  schemas[name] = reduceSchema(schema);
  collectRefs(schemas[name], pending);
}

const snapshot = {
  source: SOURCE_URL,
  title: document.info?.title,
  version: document.info?.version,
  operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))),
  schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
};

await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(operations).length} operations and ${Object.keys(schemas).length} schemas ` +
    `from ${snapshot.title} ${snapshot.version} to spec/checkbox-api.snapshot.json`,
);
