'use strict';

// Contracts the Node-RED editor expects from the node definitions. These are easy to break while
// editing the HTML files, and the failure is silent: the dialog saves, but Node-RED stores the
// wrong value.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');

function readEditor(file) {
  return fs.readFileSync(path.join(LIB, file), 'utf8');
}

function registeredTypes(source) {
  return [...source.matchAll(/RED\.nodes\.registerType\('([^']+)'/g)].map((match) => match[1]);
}

function credentialNames(source) {
  const block = /credentials:\s*\{([\s\S]*?)\n\s{8,}\}/.exec(source);
  if (!block) {
    return [];
  }
  return [...block[1].matchAll(/^\s*([A-Za-z_$][\w$]*):\s*\{/gm)].map((match) => match[1]);
}


function templateOf(source, type) {
  const template = new RegExp(
    `<script type="text/html" data-template-name="${type}">([\\s\\S]*?)</script>`,
  ).exec(source);
  return template ? template[1] : '';
}

const editors = fs
  .readdirSync(LIB)
  .filter((file) => file.endsWith('.html'))
  .map((file) => ({ file, source: readEditor(file) }));

test('every editor registers the node type of its file', () => {
  for (const { file, source } of editors) {
    assert.equal(registeredTypes(source).length, 1, `${file} must register exactly one node type`);
  }
});

test('a credential has an input with the same id as its name', () => {
  // Node-RED reads the credential from the element whose id is `<prefix>-<credentialName>` when
  // the dialog is saved. Without it, the "has a password" marker is written as the value and the
  // real secret is lost; keeping the value in a differently named field (a typed input, for
  // example) is not enough, so a hidden input with the credential name must exist as well.
  for (const { file, source } of editors) {
    const [type] = registeredTypes(source);
    const credentials = credentialNames(source);
    if (!credentials.length) {
      continue;
    }
    const template = templateOf(source, type);
    assert.ok(template, `${file} has a template for ${type}`);

    for (const credential of credentials) {
      const id = `node-config-input-${credential}`;
      assert.match(
        template,
        new RegExp(`id="${id}"`),
        `${file}: credential "${credential}" needs an input with id "${id}"`,
      );
    }
  }
});

test('every icon the editors reference is shipped with the package', () => {
  const server = path.join(__dirname, '..');
  // Node-RED looks for icons in an `icons` folder beside the .js file, so the editors live in
  // lib/ and the folder must be lib/icons.
  const iconDir = path.join(LIB, 'icons');
  for (const { file, source } of editors) {
    for (const match of source.matchAll(/icon:\s*'([^']+)'/g)) {
      const icon = match[1];
      if (icon.startsWith('font-awesome/')) {
        continue;
      }
      if (icon === 'subflow.svg' || icon === 'bridge.svg') {
        // Core icons resolved by Node-RED itself, not package icons.
        continue;
      }
      assert.ok(
        fs.existsSync(path.join(iconDir, icon)),
        `${file}: icon "${icon}" must exist in ${path.relative(server, iconDir)}`,
      );
    }
  }
});
