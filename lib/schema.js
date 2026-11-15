'use strict';

const z = require('zod');

// JSON Schema (draft-07 subset emitted by the Tool node) -> zod, used to validate
// tool input without adding a JSON Schema converter dependency.
function jsonSchemaToZod(schema, path = 'parameters') {
  if (!schema || typeof schema !== 'object') {
    throw new Error(`${path} must be a JSON Schema object`);
  }
  const type = Array.isArray(schema.type) ? schema.type.find((value) => value !== 'null') : schema.type;
  let built;
  switch (type) {
    case undefined:
      built = z.unknown();
      break;
    case 'string':
      built = z.string();
      if (Number.isInteger(schema.minLength)) built = built.min(schema.minLength);
      if (Number.isInteger(schema.maxLength)) built = built.max(schema.maxLength);
      if (typeof schema.pattern === 'string') {
        try {
          built = built.regex(new RegExp(schema.pattern));
        } catch {
          // Ignore unsupported patterns so the tool call is still validated structurally.
        }
      }
      break;
    case 'number':
      built = z.number();
      if (typeof schema.minimum === 'number') built = built.min(schema.minimum);
      if (typeof schema.maximum === 'number') built = built.max(schema.maximum);
      break;
    case 'integer':
      built = z.number().int();
      if (typeof schema.minimum === 'number') built = built.min(schema.minimum);
      if (typeof schema.maximum === 'number') built = built.max(schema.maximum);
      break;
    case 'boolean':
      built = z.boolean();
      break;
    case 'null':
      built = z.null();
      break;
    case 'array': {
      const items = schema.items ? jsonSchemaToZod(schema.items, `${path}.items`) : z.unknown();
      built = z.array(items);
      if (Number.isInteger(schema.minItems)) built = built.min(schema.minItems);
      if (Number.isInteger(schema.maxItems)) built = built.max(schema.maxItems);
      break;
    }
    case 'object': {
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      const shape = {};
      for (const [key, value] of Object.entries(properties)) {
        let field = jsonSchemaToZod(value, `${path}.${key}`);
        if (value && typeof value.description === 'string' && value.description) {
          field = field.describe(value.description);
        }
        if (!required.includes(key)) {
          field = field.optional();
        }
        shape[key] = field;
      }
      built = z.object(shape);
      if (schema.additionalProperties === false) {
        built = built.strict();
      }
      break;
    }
    default:
      built = z.unknown();
  }
  if (type && type !== 'null' && Array.isArray(schema.type) && schema.type.includes('null')) {
    built = built.nullable();
  }
  if (schema.default !== undefined) {
    built = built.default(schema.default);
  }
  return built;
}

function formatIssues(error) {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

module.exports = { jsonSchemaToZod, formatIssues };
